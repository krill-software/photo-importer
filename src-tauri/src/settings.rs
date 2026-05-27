//! App settings persisted to `$XDG_STATE_HOME/krill-photo-importer/settings.json`.
//!
//! M3 only needs one thing: the last destination folder, so the next
//! import opens the dialog there instead of starting from $HOME. Future
//! settings (HEIC→JPEG conversion mode, Live Photos behavior, etc.)
//! add new fields here.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    #[serde(rename = "lastDestination", default, skip_serializing_if = "Option::is_none")]
    pub last_destination: Option<String>,
}

pub fn state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("state")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("krill-photo-importer")
}

fn settings_path() -> PathBuf {
    state_dir().join("settings.json")
}

pub fn load() -> Settings {
    let path = settings_path();
    let Ok(bytes) = std::fs::read(&path) else { return Settings::default() };
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        eprintln!("[photo-importer] settings.json malformed: {e:?}");
        Settings::default()
    })
}

pub fn save(s: &Settings) -> Result<()> {
    let dir = state_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
    let bytes = serde_json::to_vec_pretty(s)?;
    std::fs::write(settings_path(), bytes).context("writing settings.json")?;
    Ok(())
}
