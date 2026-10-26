use crate::model::Error;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// Called by the existing blocking-worker dispatcher, never on the UI thread.
// The frontend gets only this SQLite-specific picker, no generic filesystem API.
pub fn choose<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: &Value,
) -> Result<Value, Error> {
    let create = match request["mode"].as_str() {
        Some("open") => false,
        Some("create") => true,
        _ => return Err(Error::new("VALIDATION", "Choose open or create mode.")),
    };
    let mut picker = app
        .dialog()
        .file()
        .add_filter("SQLite databases", &["sqlite", "sqlite3", "db", "db3"])
        .add_filter("All files", &["*"]);
    if let Some(window) = app.get_webview_window("main") {
        picker = picker.set_parent(&window);
    }
    if let Some(current) = request["path"].as_str().filter(|path| !path.is_empty()) {
        let path = Path::new(current);
        let directory = if path.is_dir() {
            Some(path)
        } else {
            path.parent()
        };
        if let Some(directory) = directory.filter(|directory| directory.is_dir()) {
            picker = picker.set_directory(directory);
        }
    }
    let selected = if create {
        picker
            .set_title("Create a SQLite database")
            .set_file_name("database.sqlite")
            .blocking_save_file()
    } else {
        picker
            .set_title("Open a SQLite database")
            .blocking_pick_file()
    };
    let path = selected
        .map(|file| {
            file.into_path()
                .map_err(|_| Error::new("FILE_PATH", "Choose a local file on this computer."))
        })
        .transpose()?;
    Ok(json!(validate_selection(path, create)?))
}
fn validate_selection(path: Option<PathBuf>, create: bool) -> Result<Option<String>, Error> {
    let Some(path) = path else { return Ok(None) };
    if create && path.exists() {
        return Err(Error::new(
            "FILE_EXISTS",
            "This file already exists. Choose Open existing to use it, or select a different filename. No file was replaced.",
        ));
    }
    if !create && !path.is_file() {
        return Err(Error::new(
            "FILE_MISSING",
            "The selected database file is no longer available.",
        ));
    }
    if create && !path.parent().is_some_and(Path::is_dir) {
        return Err(Error::new(
            "FILE_DIRECTORY",
            "Choose an existing folder for the new database.",
        ));
    }
    let text = path.into_os_string().into_string().map_err(|_| {
        Error::new(
            "FILE_PATH",
            "This file path cannot be represented as Unicode. Choose another path.",
        )
    })?;
    Ok(Some(text))
}
pub fn choose_tls<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Value, Error> {
    let mut picker = app.dialog().file().add_filter(
        "PEM certificates and keys",
        &["pem", "crt", "cer", "key", "der"],
    );
    if let Some(window) = app.get_webview_window("main") {
        picker = picker.set_parent(&window);
    }
    let path = picker
        .set_title("Select a TLS certificate or key")
        .blocking_pick_file()
        .map(|f| {
            f.into_path()
                .map_err(|_| Error::new("TLS_FILE", "Choose a local certificate or key file."))
        })
        .transpose()?;
    Ok(json!(validate_selection(path, false)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_returns_no_path() {
        assert_eq!(validate_selection(None, false).unwrap(), None);
        assert_eq!(validate_selection(None, true).unwrap(), None);
    }
    #[test]
    fn selection_does_not_create_or_replace_files() {
        let dir = std::env::temp_dir().join(format!("kitsune-picker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let existing = dir.join("existing.db");
        std::fs::write(&existing, b"preserve original bytes").unwrap();
        assert_eq!(
            validate_selection(Some(existing.clone()), false).unwrap(),
            Some(existing.to_string_lossy().into())
        );
        assert_eq!(
            validate_selection(Some(existing.clone()), true)
                .unwrap_err()
                .code,
            "FILE_EXISTS"
        );
        assert_eq!(
            std::fs::read(&existing).unwrap(),
            b"preserve original bytes"
        );
        let new = dir.join("new.sqlite");
        assert!(
            validate_selection(Some(new.clone()), true)
                .unwrap()
                .is_some()
        );
        assert!(!new.exists());
        assert!(validate_selection(Some(new), false).is_err());
        assert!(validate_selection(Some(dir.clone()), false).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
