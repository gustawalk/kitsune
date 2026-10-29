//! Password-protected storage. Only ciphertext and public KDF metadata reach disk.
use crate::{model::Error, storage::Storage};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::STANDARD};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zeroize::{Zeroize, Zeroizing};

const COLLECTION: &str = "credential_vault";
const ID: &str = "default";
// The version fixes both KDF parameters and the authenticated application context.
const CONTEXT: &[u8] = b"kitsune-credential-vault-v1:argon2id:m65536:t3:p1";
const MAX_BYTES: usize = 1024 * 1024;
#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u8,
    salt: String,
    nonce: String,
    ciphertext: String,
}
#[derive(Default)]
pub struct Vault {
    key: Option<Zeroizing<[u8; 32]>>,
}
#[derive(Default, Serialize, Deserialize)]
struct Secrets(BTreeMap<String, String>);
impl Drop for Secrets {
    fn drop(&mut self) {
        for password in self.0.values_mut() {
            password.zeroize();
        }
    }
}
fn failure() -> Error {
    Error::new(
        "VAULT_AUTH",
        "Could not unlock the vault. Check the master password; a damaged vault also cannot be unlocked.",
    )
}
fn crypto_error() -> Error {
    Error::new(
        "VAULT_CRYPTO",
        "The encrypted password vault could not be updated.",
    )
}
fn derive(master: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, Error> {
    if master.len() > 1024 {
        return Err(Error::new("VALIDATION", "Master password is too long."));
    }
    let mut key = Zeroizing::new([0u8; 32]);
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|_| crypto_error())?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(master.as_bytes(), salt, key.as_mut())
        .map_err(|_| crypto_error())?;
    Ok(key)
}
fn decode(value: &str, expected: usize) -> Result<Vec<u8>, Error> {
    if value.len() > MAX_BYTES * 2 {
        return Err(failure());
    }
    let bytes = STANDARD.decode(value).map_err(|_| failure())?;
    if bytes.len() != expected {
        return Err(failure());
    }
    Ok(bytes)
}
fn decrypt(envelope: &Envelope, key: &[u8; 32]) -> Result<Secrets, Error> {
    if envelope.version != 1 || envelope.ciphertext.len() > MAX_BYTES * 2 {
        return Err(failure());
    }
    let nonce = decode(&envelope.nonce, 24)?;
    let mut context = CONTEXT.to_vec();
    context.extend_from_slice(&decode(&envelope.salt, 16)?);
    let encrypted = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| failure())?;
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new(key.into())
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &encrypted,
                    aad: &context,
                },
            )
            .map_err(|_| failure())?,
    );
    serde_json::from_slice(&plain).map_err(|_| failure())
}
fn encrypt(secrets: &Secrets, key: &[u8; 32], salt: String) -> Result<Envelope, Error> {
    let plain = Zeroizing::new(serde_json::to_vec(secrets).map_err(|_| crypto_error())?);
    if plain.len() > MAX_BYTES {
        return Err(Error::new("VAULT_LIMIT", "The password vault is full."));
    }
    let mut nonce = [0u8; 24];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| crypto_error())?;
    let mut context = CONTEXT.to_vec();
    context.extend_from_slice(&decode(&salt, 16)?);
    let encrypted = XChaCha20Poly1305::new(key.into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: &context,
            },
        )
        .map_err(|_| crypto_error())?;
    Ok(Envelope {
        version: 1,
        salt,
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(encrypted),
    })
}
fn persist(storage: &Storage, next: &Envelope, previous: Option<&Envelope>) -> Result<(), Error> {
    let body = serde_json::to_string(next).map_err(|_| crypto_error())?;
    let db = storage.db.lock().map_err(|_| crypto_error())?;
    let changed = if let Some(previous) = previous {
        let expected = serde_json::to_string(previous).map_err(|_| crypto_error())?;
        db.execute(
            "UPDATE documents SET body=?1 WHERE collection=?2 AND id=?3 AND body=?4",
            rusqlite::params![body, COLLECTION, ID, expected],
        )?
    } else {
        db.execute("INSERT INTO documents(collection,id,body) VALUES(?1,?2,?3) ON CONFLICT(collection,id) DO NOTHING", rusqlite::params![COLLECTION, ID, body])?
    };
    if changed != 1 {
        return Err(Error::new(
            "VAULT_CHANGED",
            "The vault changed in another app instance. Retry the operation.",
        ));
    }
    Ok(())
}
impl Vault {
    pub fn status(&self, storage: &Storage) -> Result<serde_json::Value, Error> {
        Ok(
            serde_json::json!({"initialized": storage.get::<Envelope>(COLLECTION, ID)?.is_some(), "unlocked": self.key.is_some()}),
        )
    }
    pub fn create(&mut self, storage: &Storage, master: &str) -> Result<(), Error> {
        if storage.get::<Envelope>(COLLECTION, ID)?.is_some() {
            return Err(Error::new(
                "VAULT_EXISTS",
                "A vault already exists. Unlock it with its master password.",
            ));
        }
        if master.chars().count() < 12 {
            return Err(Error::new(
                "VALIDATION",
                "Use a master password of at least 12 characters.",
            ));
        }
        let mut salt = [0u8; 16];
        OsRng
            .try_fill_bytes(&mut salt)
            .map_err(|_| crypto_error())?;
        let key = derive(master, &salt)?;
        let encrypted = encrypt(&Secrets::default(), &key, STANDARD.encode(salt))?;
        persist(storage, &encrypted, None)?;
        self.key = Some(key);
        Ok(())
    }
    pub fn unlock(&mut self, storage: &Storage, master: &str) -> Result<(), Error> {
        let encrypted = self.envelope(storage)?;
        if encrypted.version != 1 {
            return Err(failure());
        }
        let salt = decode(&encrypted.salt, 16)?;
        let key = derive(master, &salt)?;
        decrypt(&encrypted, &key)?;
        self.key = Some(key);
        Ok(())
    }
    pub fn lock(&mut self) {
        self.key = None;
    }
    fn envelope(&self, storage: &Storage) -> Result<Envelope, Error> {
        storage
            .get(COLLECTION, ID)?
            .ok_or_else(|| Error::new("VAULT_MISSING", "Create a local password vault first."))
    }
    fn key(&self) -> Result<&[u8; 32], Error> {
        self.key.as_deref().ok_or_else(|| Error::new("VAULT_LOCKED", "Unlock the local password vault in connection settings or Settings before using saved passwords."))
    }
    pub fn load(&self, storage: &Storage, id: &str) -> Result<String, Error> {
        let key = self.key()?;
        let mut secrets = decrypt(&self.envelope(storage)?, key)?;
        secrets.0.remove(id).ok_or_else(|| {
            Error::new(
                "CREDENTIAL_MISSING",
                "Enter this connection's password to save it in the local vault.",
            )
        })
    }
    pub fn save(&self, storage: &Storage, id: &str, password: &str) -> Result<(), Error> {
        let key = self.key()?;
        let envelope = self.envelope(storage)?;
        let mut secrets = decrypt(&envelope, key)?;
        if password.is_empty() {
            if let Some(mut old) = secrets.0.remove(id) {
                old.zeroize();
            }
        } else if let Some(mut old) = secrets.0.insert(id.into(), password.into()) {
            old.zeroize();
        }
        let encrypted = encrypt(&secrets, key, envelope.salt.clone())?;
        // One SQLite update commits the entire authenticated vault atomically.
        persist(storage, &encrypted, Some(&envelope))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_vault_survives_restart_and_rejects_tampering() {
        let path =
            std::env::temp_dir().join(format!("kitsune-vault-{}.sqlite3", uuid::Uuid::new_v4()));
        let storage = Storage::open(&path).unwrap();
        let mut vault = Vault::default();
        assert_eq!(vault.status(&storage).unwrap()["initialized"], false);
        assert_eq!(
            vault.create(&storage, "short").unwrap_err().code,
            "VALIDATION"
        );
        vault
            .create(&storage, "test master passphrase only")
            .unwrap();
        assert_eq!(
            vault
                .create(&storage, "other test master passphrase")
                .unwrap_err()
                .code,
            "VAULT_EXISTS"
        );
        vault
            .save(&storage, "db-one", "test-only-database-secret")
            .unwrap();
        let first: Envelope = storage.get(COLLECTION, ID).unwrap().unwrap();
        vault
            .save(&storage, "db-two", "another-test-secret")
            .unwrap();
        let saved: Envelope = storage.get(COLLECTION, ID).unwrap().unwrap();
        assert_ne!(first.nonce, saved.nonce);
        assert_eq!(
            persist(&storage, &saved, Some(&first)).unwrap_err().code,
            "VAULT_CHANGED"
        );
        let disk = std::fs::read(&path).unwrap();
        assert!(
            !disk
                .windows(b"test-only-database-secret".len())
                .any(|w| w == b"test-only-database-secret")
        );
        assert!(
            !disk
                .windows(b"test master passphrase only".len())
                .any(|w| w == b"test master passphrase only")
        );
        drop(vault);
        let mut restarted = Vault::default();
        assert_eq!(
            restarted.load(&storage, "db-one").unwrap_err().code,
            "VAULT_LOCKED"
        );
        assert_eq!(
            restarted
                .unlock(&storage, "wrong test passphrase")
                .unwrap_err()
                .code,
            "VAULT_AUTH"
        );
        assert_eq!(restarted.status(&storage).unwrap()["unlocked"], false);
        restarted
            .unlock(&storage, "test master passphrase only")
            .unwrap();
        assert_eq!(
            restarted.load(&storage, "db-one").unwrap(),
            "test-only-database-secret"
        );
        let mut modified: Envelope = storage.get(COLLECTION, ID).unwrap().unwrap();
        modified.salt = STANDARD.encode([42u8; 16]);
        storage.put(COLLECTION, ID, &modified).unwrap();
        assert_eq!(
            restarted
                .save(&storage, "db-one", "replacement")
                .unwrap_err()
                .code,
            "VAULT_AUTH"
        );
        storage.put(COLLECTION, ID, &saved).unwrap();
        let mut encrypted = STANDARD.decode(&saved.ciphertext).unwrap();
        encrypted[0] ^= 1;
        modified.salt = saved.salt.clone();
        modified.ciphertext = STANDARD.encode(encrypted);
        storage.put(COLLECTION, ID, &modified).unwrap();
        assert_eq!(
            restarted.load(&storage, "db-one").unwrap_err().code,
            "VAULT_AUTH"
        );
        modified.nonce = "bad nonce".into();
        storage.put(COLLECTION, ID, &modified).unwrap();
        assert!(restarted.load(&storage, "db-one").is_err());
        storage.put(COLLECTION, ID, &saved).unwrap();
        restarted.save(&storage, "db-one", "").unwrap();
        assert_eq!(
            restarted.load(&storage, "db-one").unwrap_err().code,
            "CREDENTIAL_MISSING"
        );
        assert_eq!(
            restarted.load(&storage, "db-two").unwrap(),
            "another-test-secret"
        );
        restarted.lock();
        assert_eq!(restarted.status(&storage).unwrap()["unlocked"], false);
        assert_eq!(
            restarted
                .save(&storage, "db-two", "changed")
                .unwrap_err()
                .code,
            "VAULT_LOCKED"
        );
        drop(storage);
        std::fs::remove_file(path).unwrap();
    }
}
