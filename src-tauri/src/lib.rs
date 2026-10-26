mod commands;
mod database;
mod diagnostics;
mod exports;
mod file_picker;
#[cfg(test)]
mod ipc_tests;
mod model;
mod monitor;
mod restore;
mod safety;
mod security;
mod state;
mod storage;
#[cfg(test)]
mod tests;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    let _ = tracing::subscriber::set_global_default(security::SafeLog);
    let app=tauri::Builder::default().plugin(tauri_plugin_dialog::init()).setup(|app|{commands::setup(app)?;window::restore(app);Ok(())}).on_window_event(|window,event|{if matches!(event,tauri::WindowEvent::CloseRequested{..}){window::save(window);}}).invoke_handler(tauri::generate_handler![commands::api]).build(tauri::generate_context!()).expect("Kitsune could not initialize. Application metadata was preserved; check local file permissions and integrity.");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = handle.state::<state::AppState>();
            if let Ok(sessions) = state.sessions.lock() {
                let ids: Vec<_> = sessions.keys().cloned().collect();
                drop(sessions);
                for id in ids {
                    state.stop_connection(&id);
                }
            }
        }
    });
}
