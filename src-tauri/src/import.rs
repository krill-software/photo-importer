//! Batch import flow: copy a list of media files from the iPhone mount
//! to a user-picked destination, emitting per-file progress events as
//! we go.
//!
//! Per SPEC's hard read-only guarantee, this is a **strict copy** — we
//! open the source for reading via tokio::fs::copy, never call unlink
//! or write anywhere on the mount.
//!
//! Conflict policy: never overwrite. Suffix the final filename with
//! `(2)`, `(3)`, etc. on collision — same shape file-drop uses.
//!
//! Atomicity: each file lands at `<dest>/.<name>.partial` first, then
//! is `rename`d into place once the full byte stream is on disk. A
//! crash mid-copy leaves a hidden `.partial` file behind that the user
//! can delete; we never leave a half-written real-name file.
//!
//! Events emitted:
//!   - `import-status` `{ phase: "started",  total, totalBytes }`
//!   - `import-status` `{ phase: "copying",  current, total, name,
//!                        bytesCopied, totalBytes }`
//!   - `import-status` `{ phase: "done",     copied, total, totalBytes }`
//!   - `import-status` `{ phase: "error",    name, error,
//!                        copied, total }`  (then stops the batch)

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::fs;

pub async fn run(paths: Vec<String>, dest: PathBuf, app: AppHandle) -> Result<()> {
    if paths.is_empty() {
        return Err(anyhow!("nothing selected"));
    }
    fs::create_dir_all(&dest)
        .await
        .with_context(|| format!("creating destination {}", dest.display()))?;

    // Up-front size scan so the progress bar has a real total. Errors
    // here are non-fatal — we just won't include that file's bytes in
    // the total (it'll still get its turn in the copy loop, which
    // surfaces the real error if any).
    let total = paths.len();
    let mut total_bytes: u64 = 0;
    for p in &paths {
        if let Ok(m) = fs::metadata(p).await {
            total_bytes += m.len();
        }
    }

    let _ = app.emit("import-status", json!({
        "phase": "started",
        "total": total,
        "totalBytes": total_bytes,
    }));

    let mut copied_bytes: u64 = 0;
    for (i, src_str) in paths.iter().enumerate() {
        let src = Path::new(src_str);
        let name = src
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .ok_or_else(|| anyhow!("path has no filename: {}", src.display()))?;

        let final_path = unique_path(&dest, &name);
        let final_name = final_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        let partial_path = dest.join(format!(".{final_name}.partial"));

        let _ = app.emit("import-status", json!({
            "phase": "copying",
            "current": i + 1,
            "total": total,
            "name": final_name,
            "bytesCopied": copied_bytes,
            "totalBytes": total_bytes,
        }));

        // Best-effort cleanup if a previous run died here.
        let _ = fs::remove_file(&partial_path).await;

        let copy_result = fs::copy(src, &partial_path).await;
        let bytes_this_file = match copy_result {
            Ok(n) => n,
            Err(e) => {
                let _ = fs::remove_file(&partial_path).await;
                let _ = app.emit("import-status", json!({
                    "phase": "error",
                    "name": name,
                    "error": format!("{e:#}"),
                    "copied": i,
                    "total": total,
                }));
                return Err(anyhow!("copy {} -> {}: {e}", src.display(), partial_path.display()));
            }
        };

        if let Err(e) = fs::rename(&partial_path, &final_path).await {
            let _ = fs::remove_file(&partial_path).await;
            let _ = app.emit("import-status", json!({
                "phase": "error",
                "name": name,
                "error": format!("{e:#}"),
                "copied": i,
                "total": total,
            }));
            return Err(anyhow!("rename to {}: {e}", final_path.display()));
        }

        copied_bytes += bytes_this_file;
    }

    let _ = app.emit("import-status", json!({
        "phase": "done",
        "copied": total,
        "total": total,
        "totalBytes": total_bytes,
    }));

    Ok(())
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = split_name(name);
    for n in 2..1000 {
        let alt = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let p = dir.join(alt);
        if !p.exists() {
            return p;
        }
    }
    // Pathological fallback: timestamp suffix.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    dir.join(if ext.is_empty() {
        format!("{stem}.{ts}")
    } else {
        format!("{stem}.{ts}.{ext}")
    })
}

fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

