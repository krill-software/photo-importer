//! On-demand thumbnail generation with a disk cache.
//!
//! - JPEG / PNG / WebP / GIF / BMP / TIFF via the `image` crate.
//! - HEIC / HEIF by shelling out to `heif-thumbnailer` (the binary
//!   shipped with the `libheif-examples` Debian/Ubuntu package).
//!   Avoids the libheif-rs / libheif-sys ABI version pin that breaks
//!   builds across distros — works against whatever libheif version
//!   the host ships.
//! - Cache key = SHA-256 of `<absolute path> + <mtime ms>` so renaming
//!   the source or editing it on the iPhone invalidates cleanly.
//! - Output: 256×256-max JPEG at quality 80.
//! - Concurrency cap: 4 simultaneous decodes (libheif is CPU-bound and
//!   USB-read-bound; more than 4 doesn't help and starves the UI).
//!
//! Returns a `data:image/jpeg;base64,…` URL so the webview can `<img
//! src=>` it directly without enabling Tauri's asset protocol.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::{imageops::FilterType, DynamicImage};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::sync::Semaphore;

const THUMB_MAX: u32 = 256;
const THUMB_QUALITY: u8 = 80;
const MAX_CONCURRENT_DECODES: usize = 4;

static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
fn sem() -> Arc<Semaphore> {
    SEM.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_DECODES)))
        .clone()
}

fn cache_dir() -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("krill-photo-importer")
        .join("thumbs")
}

fn thumb_path(src: &Path, mtime_ms: u64) -> PathBuf {
    let mut h = Sha256::new();
    h.update(src.to_string_lossy().as_bytes());
    h.update(mtime_ms.to_le_bytes());
    cache_dir().join(format!("{}.jpg", hex::encode(h.finalize())))
}

/// Returns a `data:image/jpeg;base64,…` URL for a thumbnail of `src`,
/// generating + caching it on disk if needed.
pub async fn thumb_data_url(src: &Path) -> Result<String> {
    let bytes = ensure_thumb(src).await?;
    Ok(format!("data:image/jpeg;base64,{}", B64.encode(&bytes)))
}

async fn ensure_thumb(src: &Path) -> Result<Vec<u8>> {
    let meta = fs::metadata(src)
        .await
        .with_context(|| format!("stat {}", src.display()))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let out = thumb_path(src, mtime_ms);

    // Cache hit — read from disk and return.
    if let Ok(bytes) = fs::read(&out).await {
        return Ok(bytes);
    }

    // Cache miss. Cap concurrent decodes so libheif + USB don't pin
    // the UI thread.
    let _permit = sem().acquire_owned().await?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).await.ok();
    }

    // Image decoding + resizing is CPU-bound + sync; run on a blocking
    // worker so we don't stall the async runtime.
    let src_owned = src.to_owned();
    let out_owned = out.clone();
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        let img = decode_source(&src_owned)?;
        let thumb = img.resize(THUMB_MAX, THUMB_MAX, FilterType::Triangle);
        // Re-encode as JPEG with controlled quality, write to cache,
        // and return the bytes inline.
        let mut buf = Vec::new();
        {
            use image::codecs::jpeg::JpegEncoder;
            let rgb = thumb.to_rgb8();
            let mut encoder = JpegEncoder::new_with_quality(&mut buf, THUMB_QUALITY);
            encoder.encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )?;
        }
        std::fs::write(&out_owned, &buf).ok();
        Ok(buf)
    })
    .await
    .context("thumb spawn_blocking panicked")??;

    Ok(bytes)
}

fn decode_source(path: &Path) -> Result<DynamicImage> {
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "heic" | "heif" => decode_heic(path),
        _ => {
            let reader = image::ImageReader::open(path)
                .with_context(|| format!("opening {}", path.display()))?
                .with_guessed_format()
                .with_context(|| format!("guessing format for {}", path.display()))?;
            reader
                .decode()
                .with_context(|| format!("decoding {}", path.display()))
        }
    }
}

/// Counter for unique temp-file names so concurrent thumbnail jobs
/// don't collide. Combined with PID so multiple instances don't fight.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn decode_heic(path: &Path) -> Result<DynamicImage> {
    // heif-thumbnailer ships with libheif-examples. It outputs a JPEG
    // (or PNG, depending on extension) at a max edge size we choose,
    // so this fully replaces the libheif-rs FFI path with no version
    // pinning headaches.
    //
    // Usage: `heif-thumbnailer -s 320 input.heic output.jpg`
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!(
        "krill-photo-importer-heic-{}-{n}.jpg",
        std::process::id(),
    ));

    let status = std::process::Command::new("heif-thumbnailer")
        .args(["-s", "320"])
        .arg(path)
        .arg(&tmp)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .context(
            "running heif-thumbnailer (install `libheif-examples` for HEIC support)",
        )?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(anyhow!("heif-thumbnailer exited {status}"));
    }

    let img = image::ImageReader::open(&tmp)
        .with_context(|| format!("opening thumbnailer output at {}", tmp.display()))?
        .with_guessed_format()?
        .decode()?;
    let _ = std::fs::remove_file(&tmp);
    Ok(img)
}
