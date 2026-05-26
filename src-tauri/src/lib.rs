mod device;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use krill_desktop_core::updater::BuilderExt;

#[derive(Default)]
struct AppCtx {
    /// Currently-mounted iPhone path, if any. We unmount on shutdown.
    mount: Mutex<Option<PathBuf>>,
}

#[tauri::command]
async fn probe_device() -> device::DeviceState {
    device::probe().await
}

#[tauri::command]
async fn mount_device(
    udid: String,
    state: State<'_, Arc<AppCtx>>,
) -> Result<String, String> {
    // If we have a stale mount, unmount it first.
    let prev = state.mount.lock().await.take();
    if let Some(p) = prev {
        let _ = device::unmount(&p).await;
    }
    let m = device::mount(&udid).await.map_err(|e| e.to_string())?;
    let display = m.display().to_string();
    *state.mount.lock().await = Some(m);
    Ok(display)
}

#[tauri::command]
async fn list_media(
    state: State<'_, Arc<AppCtx>>,
) -> Result<Vec<device::MediaItem>, String> {
    let g = state.mount.lock().await;
    let Some(mount) = g.as_ref() else {
        return Err("iPhone not mounted".into());
    };
    device::list_media(mount).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn unmount_device(state: State<'_, Arc<AppCtx>>) -> Result<(), String> {
    let prev = state.mount.lock().await.take();
    if let Some(p) = prev {
        device::unmount(&p).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// On window close / app quit, drain the mount so we never leave a
/// dangling FUSE mountpoint behind.
async fn cleanup_on_exit(app: AppHandle) {
    let ctx: State<'_, Arc<AppCtx>> = app.state();
    let prev = ctx.mount.lock().await.take();
    if let Some(p) = prev {
        let _ = device::unmount(&p).await;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ctx = Arc::new(AppCtx::default());
    tauri::Builder::default()
        .manage(ctx)
        .with_updater()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle().clone();
                tauri::async_runtime::block_on(async move {
                    cleanup_on_exit(app).await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            probe_device,
            mount_device,
            list_media,
            unmount_device,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
