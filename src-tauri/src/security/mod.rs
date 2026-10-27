//! Structured logs intentionally accept only operational metadata. Query text,
//! credentials, identifiers, result values and arbitrary Debug fields are ignored.
use serde_json::{Map, Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use tracing::{
    Event, Metadata, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
#[derive(Default)]
struct SafeFields(Map<String, Value>);
impl Visit for SafeFields {
    fn record_bool(&mut self, field: &Field, value: bool) {
        if field.name() == "success" {
            self.0.insert(field.name().into(), json!(value));
        }
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        if field.name() == "duration_ms" {
            self.0.insert(field.name().into(), json!(value));
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        let valid = match field.name() {
            "driver" => ["sqlite", "postgres"].contains(&value),
            "operation" => {
                ["execute", "connect", "disconnect", "watch", "metadata"].contains(&value)
            }
            "code" => {
                value.len() <= 64
                    && value
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            }
            _ => false,
        };
        if valid {
            self.0.insert(field.name().into(), json!(value));
        }
    }
    fn record_debug(&mut self, _: &Field, _: &dyn std::fmt::Debug) {}
}
pub struct SafeLog;
static NEXT_SPAN: AtomicU64 = AtomicU64::new(1);
impl Subscriber for SafeLog {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.target().starts_with("kitsune_lib") && metadata.level() <= &tracing::Level::INFO
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(NEXT_SPAN.fetch_add(1, Ordering::Relaxed))
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        let mut fields = SafeFields::default();
        event.record(&mut fields);
        eprintln!(
            "{}",
            json!({"timestamp":chrono::Utc::now().to_rfc3339(),"level":event.metadata().level().as_str(),"target":event.metadata().target(),"fields":fields.0})
        );
    }
}
pub mod credentials;
