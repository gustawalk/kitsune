use crate::{
    model::{ConnectionConfig, Error},
    state::AppState,
};
fn local(config: &ConnectionConfig) -> Result<bool, Error> {
    match config.credential_store.as_str() {
        "localVault" => Ok(true),
        "operatingSystem" => Ok(false),
        _ => Err(Error::new("VALIDATION", "Invalid password storage option.")),
    }
}
pub fn load(state: &AppState, config: &ConnectionConfig) -> Result<String, Error> {
    if local(config)? {
        state
            .vault
            .lock()
            .map_err(|_| unavailable())?
            .load(&state.storage, &config.id)
    } else {
        super::credentials::load(&config.id)
    }
}
pub fn save(state: &AppState, config: &ConnectionConfig) -> Result<(), Error> {
    if local(config)? {
        state.vault.lock().map_err(|_| unavailable())?.save(
            &state.storage,
            &config.id,
            &config.password,
        )
    } else {
        super::credentials::save(&config.id, &config.password)
    }
}
pub fn remove(state: &AppState, config: &ConnectionConfig) -> Result<(), Error> {
    if local(config)? {
        state
            .vault
            .lock()
            .map_err(|_| unavailable())?
            .save(&state.storage, &config.id, "")
    } else {
        super::credentials::remove(&config.id)
    }
}
fn unavailable() -> Error {
    Error::new("STATE", "Password storage is unavailable.")
}
