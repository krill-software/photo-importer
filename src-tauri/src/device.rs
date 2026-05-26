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
    /// No iPhone plugged in.
    None,
    /// Detected but not trusted yet. `hint` is the human-readable next
    /// step — varies depending on whether the iPhone is locked, needs a
    /// passcode, or just needs the Trust dialog acknowledged.
    NeedsTrust { device: Device, hint: String },
    /// Connected, paired, ready.
    Ready { device: Device },
}

/// Per-component snapshot of the host environment. Each entry is a
/// single thing we depend on, so the UI can tell the user *exactly*
/// what's missing instead of one blanket "install three packages"
/// banner.
#[derive(Debug, Serialize, Clone)]
pub struct EnvCheck {
    /// `idevice_id` binary — proxy for `libimobiledevice-utils`.
    pub idevice_id: bool,
    /// `ifuse` binary — separate Debian package.
    pub ifuse: bool,
    /// `fusermount` binary — proxy for FUSE userspace.
    pub fusermount: bool,
    /// `/var/run/usbmuxd` socket present — proxy for the usbmuxd daemon
    /// actually running. The package usually ships a systemd unit that
    /// starts on boot, but in containers or minimal installs it might
    /// not be active.
    pub usbmuxd_running: bool,
}

pub async fn check_env() -> EnvCheck {
    EnvCheck {
        idevice_id: which("idevice_id").await,
        ifuse: which("ifuse").await,
        fusermount: which("fusermount").await,
        usbmuxd_running: usbmuxd_reachable().await,
    }
}

async fn usbmuxd_reachable() -> bool {
    // The daemon owns /var/run/usbmuxd (Unix socket). Presence is a
    // good-enough proxy without actually speaking the protocol.
    fs::metadata("/var/run/usbmuxd").await.is_ok()
}

/// Probe for a connected iPhone.
///
/// Returns the first device found (M1 supports a single device — multi-
/// device handling is a future polish item once we know what the UX
/// should be).
pub async fn probe() -> DeviceState {
    let udid = match first_udid().await {
        Ok(Some(udid)) => udid,
        Ok(None) => return DeviceState::None,
        Err(e) => {
            eprintln!("[photo-importer] idevice_id failed: {e:?}");
            return DeviceState::None;
        }
    };

    // If we can read the device name without pairing, we're already
    // trusted from a previous session — done.
    if let Ok(name) = device_name(&udid).await {
        return DeviceState::Ready { device: Device { udid, name } };
    }

    // Not trusted yet. Read-only queries silently fail in this state —
    // iOS only surfaces the Trust dialog when something actively tries
    // to pair, so we explicitly invoke `idevicepair pair` and parse its
    // output to figure out which next-step hint to show.
    let outcome = try_pair(&udid).await;
    if matches!(outcome, PairOutcome::Trusted) {
        // The user accepted the dialog while we were still in this
        // function (rare but possible) — re-fetch the name and proceed.
        let name = device_name(&udid).await.unwrap_or_else(|_| "iPhone".into());
        return DeviceState::Ready { device: Device { udid, name } };
    }
    let hint = match outcome {
        PairOutcome::Trusted => unreachable!(),
        PairOutcome::PromptShown =>
            "Look at your iPhone and tap “Trust This Computer.” Then click Refresh.".into(),
        PairOutcome::NeedsUnlock =>
            "Unlock your iPhone first, then click Refresh.".into(),
        PairOutcome::Other(msg) =>
            format!("Pairing didn't start: {msg}"),
    };
    DeviceState::NeedsTrust {
        device: Device { udid, name: "iPhone".into() },
        hint,
    }
}

enum PairOutcome {
    /// `SUCCESS: Paired with device …` — fully paired, can proceed.
    Trusted,
    /// `Please accept the trust dialog on the screen of device …` —
    /// the dialog is now showing on the iPhone, waiting on the user.
    PromptShown,
    /// `Could not connect to lockdownd: Please make sure the device is
    /// unlocked` or similar passcode-related text — phone is locked.
    NeedsUnlock,
    /// Anything else — surface the first line back to the user.
    Other(String),
}

async fn try_pair(udid: &str) -> PairOutcome {
    let out = Command::new("idevicepair")
        .args(["-u", udid, "pair"])
        .output()
        .await;
    let Ok(out) = out else {
        return PairOutcome::Other("idevicepair not installed".into());
    };
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    let lower = combined.to_lowercase();
    if lower.contains("success") && lower.contains("paired") {
        return PairOutcome::Trusted;
    }
    if lower.contains("trust dialog") {
        return PairOutcome::PromptShown;
    }
    if lower.contains("unlock") || lower.contains("passcode") {
        return PairOutcome::NeedsUnlock;
    }
    let first_line = combined
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("unknown error")
        .to_string();
    PairOutcome::Other(first_line)
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

    // Aggressive pre-cleanup: a previous crash can leave a zombie FUSE
    // mountpoint at `mount` whose stat() fails with ENOTCONN, which in
    // turn breaks create_dir_all. Lazy-unmount + rmdir first, ignoring
    // every error along the way — best effort cleanup before fresh
    // mount.
    let _ = Command::new("fusermount")
        .args(["-uz"])
        .arg(&mount)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    let _ = tokio::fs::remove_dir(&mount).await;

    fs::create_dir_all(&mount).await.with_context(|| {
        format!("creating mountpoint {}", mount.display())
    })?;

    let out = Command::new("ifuse")
        .args(["-u", udid])
        .arg(&mount)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("spawning ifuse")?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(anyhow!(
            "ifuse failed (exit {}): {}",
            out.status,
            if stderr.is_empty() { "no stderr".into() } else { stderr },
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
        .join("krill-photo-importer")
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

/// Walk every `/DCIM/<NNNAPPLE>/` directory on the mount and stream
/// the media items back to the frontend in batches via Tauri events.
///
/// **Why streaming.** A user with 50 GB of media has ~tens-of-thousands
/// of files. Each stat() over the FUSE/AFC mount is a USB roundtrip;
/// the full walk takes tens of seconds. Returning one giant Vec means
/// the UI sits blank that whole time. Emitting `media-batch` events as
/// we go (50 items per batch) lets the table populate within a second
/// of click, and the spinner keeps spinning until `media-done` fires.
///
/// Events emitted (all carry the same string key):
///   - `media-batch`  — `Vec<MediaItem>` (50 at a time, last batch
///                      may be shorter)
///   - `media-done`   — `{ total: usize }` (final count, frontend can
///                      stop the spinner)
pub async fn list_media(mount: &Path, app: &tauri::AppHandle) -> Result<()> {
    use tauri::Emitter;

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

    const BATCH_SIZE: usize = 50;
    let mut buffer: Vec<MediaItem> = Vec::with_capacity(BATCH_SIZE);
    let mut total: usize = 0;

    while let Some(album) = entries.next_entry().await? {
        let p = album.path();
        if !p.is_dir() { continue; }
        // Apple uses NNNAPPLE; just walk every subdir to be lenient.
        let Ok(mut files) = fs::read_dir(&p).await else { continue };
        while let Some(f) = files.next_entry().await? {
            if let Some(item) = build_media_item(&f.path()).await {
                buffer.push(item);
                if buffer.len() >= BATCH_SIZE {
                    let chunk = std::mem::replace(
                        &mut buffer,
                        Vec::with_capacity(BATCH_SIZE),
                    );
                    total += chunk.len();
                    let _ = app.emit("media-batch", chunk);
                }
            }
        }
    }
    if !buffer.is_empty() {
        total += buffer.len();
        let _ = app.emit("media-batch", buffer);
    }
    let _ = app.emit("media-done", serde_json::json!({ "total": total }));
    Ok(())
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
