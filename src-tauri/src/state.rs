use crate::{
    database::{Database, Interrupt},
    model::*,
    storage::Storage,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
pub struct Session {
    pub config: ConnectionConfig,
    pub generation: String,
    pub main_interrupt: Mutex<Option<Arc<Interrupt>>>,
    pub monitor_permit: Arc<tokio::sync::Semaphore>,
    pub db: Mutex<Database>,
    pub monitor: Mutex<Database>,
    pub read_only: AtomicBool,
    pub connected: AtomicBool,
}
pub struct WatchTask {
    pub stop: Arc<AtomicBool>,
    pub wake: Arc<tokio::sync::Notify>,
    pub interrupt: Arc<Mutex<Option<Arc<Interrupt>>>>,
}
pub struct Approval {
    pub restore: Option<crate::restore::RestoreApproval>,
    pub expected_affected: Option<u64>,
    pub sql: String,
    pub params: Vec<Value>,
    pub connection_id: String,
    pub generation: String,
    pub script: bool,
    pub created: std::time::Instant,
}
pub struct QueryOperation {
    pub cancelled: AtomicBool,
    pub interrupt: Mutex<Option<Arc<Interrupt>>>,
}
impl QueryOperation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(handle) = self.interrupt.lock()
            && let Some(handle) = handle.as_ref()
        {
            handle.cancel();
        }
    }
}
pub struct OperationGuard<'a> {
    pub operations: &'a Mutex<HashMap<String, Arc<QueryOperation>>>,
    pub id: String,
}
impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.operations.lock() {
            operations.remove(&self.id);
        }
    }
}
pub struct AppState {
    pub approvals: Mutex<HashMap<String, Approval>>,
    pub watch_gate: Mutex<()>,
    pub watch_errors: Mutex<HashMap<String, String>>,
    pub storage: Storage,
    pub internal: PathBuf,
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub tasks: Mutex<HashMap<String, WatchTask>>,
    pub operations: Mutex<HashMap<String, Arc<QueryOperation>>>,
    pub permits: Arc<tokio::sync::Semaphore>,
}
impl AppState {
    pub fn session(&self, id: &str) -> Result<Arc<Session>, Error> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| Error::new("STATE", "Connection state unavailable."))?;
        let s = sessions
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("NOT_CONNECTED", "Connect to this database first."))?;
        if !s.connected.load(Ordering::SeqCst) {
            return Err(Error::new("NOT_CONNECTED", "This connection has closed."));
        }
        Ok(s)
    }
    pub fn stop_watch(&self, id: &str) {
        if let Ok(mut tasks) = self.tasks.lock()
            && let Some(task) = tasks.remove(id)
        {
            task.stop.store(true, Ordering::SeqCst);
            task.wake.notify_one();
            if let Ok(handle) = task.interrupt.lock()
                && let Some(handle) = handle.as_ref()
            {
                handle.cancel();
            }
        }
    }
    pub fn stop_connection(&self, id: &str) {
        let _gate = self.watch_gate.lock();
        if let Ok(mut sessions) = self.sessions.lock()
            && let Some(s) = sessions.remove(id)
        {
            s.connected.store(false, Ordering::SeqCst);
            if let Ok(handle) = s.main_interrupt.lock()
                && let Some(handle) = handle.as_ref()
            {
                handle.cancel();
            }
        }
        if let Ok(watches) = self.storage.list::<Watch>("watches") {
            for mut w in watches.into_iter().filter(|w| w.connection_id == id) {
                self.stop_watch(&w.id);
                w.status = "paused".into();
                let _ = self.storage.put("watches", &w.id, &w);
            }
        }
    }
}
