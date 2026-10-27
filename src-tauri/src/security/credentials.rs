use crate::model::Error;
use keyring::Entry;

const SERVICE: &str = "dev.kitsune.app.database";

fn entry(connection_id: &str) -> Result<Entry, Error> {
    Entry::new(SERVICE, connection_id).map_err(|_| {
        Error::new(
            "CREDENTIAL_STORE",
            "The operating-system credential store is unavailable or locked.",
        )
    })
}

pub fn save(connection_id: &str, password: &str) -> Result<(), Error> {
    if password.is_empty() {
        return remove(connection_id);
    }
    entry(connection_id)?.set_password(password).map_err(|_| {
        Error::new(
            "CREDENTIAL_STORE",
            "Could not save the password in the operating-system credential store. Unlock or configure a system keyring and try again.",
        )
    })
}

pub fn load(connection_id: &str) -> Result<String, Error> {
    entry(connection_id)?.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => Error::new(
            "CREDENTIAL_MISSING",
            "No saved password is available. Enter it in connection settings or disable Remember password.",
        ),
        _ => Error::new(
            "CREDENTIAL_STORE",
            "The operating-system credential store is unavailable or locked.",
        ),
    })
}

pub fn remove(connection_id: &str) -> Result<(), Error> {
    match entry(connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(Error::new(
            "CREDENTIAL_STORE",
            "Could not remove the saved password from the operating-system credential store.",
        )),
    }
}
