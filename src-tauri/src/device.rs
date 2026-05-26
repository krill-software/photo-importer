//! USB-attached iPhone integration.
//!
//! M1 just needs four things from `libimobiledevice` + `ifuse`:
//!   1. List paired devices              — `idevice_id -l`
//!   2. Get a device's display name      — `ideviceinfo -u <udid> -k DeviceName`
//!   3. Mount the Camera Roll            — `ifuse --documents '' <mount-point> -u <udid>`
//!                                          (actually we use plain `ifuse <mount> -u <udid>`
//!                                           which mounts the AFC root, containing /DCIM/)
//!   4. Unmount                          — `fusermount -u <mount-point>`
//!
//! Everything is shelled out via `std::process::Command`. No Rust FFI
//! layer. Cleaner: less code, mature tooling, easier debugging when
//! something at the USB protocol layer misbehaves.
//!
//! **Strictly read-only.** Per SPEC's hard safety guarantee, we never
//! call any write/unlink path against the mount. Only `read_dir`,
//! `metadata`, and `read` are used.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tokio::fs;
use tokio::process::Command;

#[derive(Debug, Serialize, Clone)]
pub struct Device {
    pub udid: String,
    pub name: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DeviceState {
    /// No iPhone plugged in (or libimobiledevice tools missing).
    None,
    /// Tools missing — show install instructions.
    ToolsMissing { which: String },
    /// Plugged in but not trusted yet — user must tap "Trust" on phone.
    NeedsTrust { device: Device },
    /// Connected, paired, ready.
    Ready { device: Device },
}

/// Probe for a connected iPhone.
///
/// Returns the first device found (M1 supports a single device — multi-
/// device handling is a future polish item once we know what the UX
/// should be).
pub async fn probe() -> DeviceState {
    if !which("idevice_id").await {
        return DeviceState::ToolsMissing { which: "idevice_id".into() };
    }

    let udid = match first_udid().await {
        Ok(Some(udid)) => udid,
        Ok(None) => return DeviceState::None,
        Err(e) => {
            eprintln!("[photos-import] idevice_id failed: {e:?}");
            return DeviceState::None;
        }
    };

    // ideviceinfo doubles as our trust probe — if the device isn't
    // paired/trusted yet, the call fails with a pairing-protocol error.
    match device_name(&udid).await {
        Ok(name) => DeviceState::Ready { device: Device { udid, name } },
        Err(_) => DeviceState::NeedsTrust {
            device: Device { udid, name: "iPhone".into() },
        },
    }
}

async fn which(bin: &str) -> bool {
    Command::new("which")
        .arg(bin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn first_udid() -> Result<Option<String>> {
    let out = Command::new("idevice_id")
        .arg("-l")
        .output()
        .await
        .context("running idevice_id -l")?;
    if !out.status.success() {
        return Err(anyhow!(
            "idevice_id exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Ok(s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()))
}

async fn device_name(udid: &str) -> Result<String> {
    let out = Command::new("ideviceinfo")
        .args(["-u", udid, "-k", "DeviceName"])
        .output()
        .await
        .context("running ideviceinfo")?;
    if !out.status.success() {
        return Err(anyhow!(
            "ideviceinfo exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() {
        Err(anyhow!("ideviceinfo returned empty DeviceName"))
    } else {
        Ok(name)
    }
}

/// Mount the iPhone's AFC root (which contains `/DCIM/`) via `ifuse`.
/// Returns the mountpoint path. Caller must call `unmount` on shutdown.
pub async fn mount(udid: &str) -> Result<PathBuf> {
    if !which("ifuse").await {
        return Err(anyhow!("ifuse not installed — `apt install ifuse`"));
    }

    let mount = mount_dir(udid);
    fs::create_dir_all(&mount).await.with_context(|| {
        format!("creating mountpoint {}", mount.display())
    })?;

    // If something's already mounted there (from a crashed previous run),
    // try to unmount cleanly first. Ignore failures — could be empty.
    let _ = unmount(&mount).await;

    let status = Command::new("ifuse")
        .args(["-u", udid])
        .arg(&mount)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .await
        .context("spawning ifuse")?;

    if !status.success() {
        return Err(anyhow!(
            "ifuse failed to mount {udid} at {} (exit {status}). \
             Tap 'Trust This Computer' on the iPhone and retry.",
            mount.display()
        ));
    }

    Ok(mount)
}

pub async fn unmount(mount: &Path) -> Result<()> {
    if !mount.exists() {
        return Ok(());
    }
    let _ = Command::new("fusermount")
        .args(["-u"])
        .arg(mount)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    Ok(())
}

fn mount_dir(udid: &str) -> PathBuf {
    cache_dir().join("mount").join(udid)
}

fn cache_dir() -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("krill-photos-import")
}

// ---- DCIM listing -------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct MediaItem {
    /// Just the filename, e.g. `IMG_0123.HEIC`.
    pub name: String,
    /// Absolute path on the mount, e.g.
    /// `/.../mount/<udid>/DCIM/100APPLE/IMG_0123.HEIC`.
    pub path: String,
    /// File extension lowercased, e.g. `heic`.
    pub ext: String,
    /// File size in bytes.
    pub size: u64,
    /// mtime in unix milliseconds (iPhone preserves capture time as mtime
    /// on the AFC mount).
    pub modified_ms: u64,
    /// `"image" | "video" | "other"`. Type derived from extension.
    pub kind: String,
}

const IMAGE_EXTS: &[&str] = &["heic", "heif", "jpg", "jpeg", "png", "gif", "webp"];
const VIDEO_EXTS: &[&str] = &["mov", "mp4", "m4v"];

/// Walk every `/DCIM/<NNNAPPLE>/` directory on the mount and produce a
/// flat list of media items, newest first.
pub async fn list_media(mount: &Path) -> Result<Vec<MediaItem>> {
    let dcim = mount.join("DCIM");
    let mut entries = match fs::read_dir(&dcim).await {
        Ok(e) => e,
        Err(e) => {
            return Err(anyhow!(
                "cannot read {} — is the iPhone still mounted? ({e})",
                dcim.display()
            ));
        }
    };

    let mut items = Vec::new();
    while let Some(album) = entries.next_entry().await? {
        let p = album.path();
        if !p.is_dir() { continue; }
        // Apple uses NNNAPPLE; just walk every subdir to be lenient.
        let Ok(mut files) = fs::read_dir(&p).await else { continue };
        while let Some(f) = files.next_entry().await? {
            if let Some(item) = build_media_item(&f.path()).await {
                items.push(item);
            }
        }
    }

    items.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(items)
}

async fn build_media_item(path: &Path) -> Option<MediaItem> {
    let meta = fs::metadata(path).await.ok()?;
    if !meta.is_file() { return None; }
    let name = path.file_name()?.to_string_lossy().to_string();
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let kind = if IMAGE_EXTS.contains(&ext.as_str()) {
        "image"
    } else if VIDEO_EXTS.contains(&ext.as_str()) {
        "video"
    } else {
        // Skip dotfiles + the AAE sidecar files Apple writes alongside
        // edited images. They're not useful to import directly.
        return None;
    };
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(MediaItem {
        name,
        path: path.display().to_string(),
        ext,
        size: meta.len(),
        modified_ms,
        kind: kind.into(),
    })
}
