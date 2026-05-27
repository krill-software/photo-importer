mod device;
mod import;
mod settings;
mod thumbs;

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
async fn check_environment() -> device::EnvCheck {
    device::check_env().await
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
    let m = device::mount(&udid).await.map_err(|e| format!("{e:#}"))?;
    let display = m.display().to_string();
    *state.mount.lock().await = Some(m);
    Ok(display)
}

#[tauri::command]
async fn list_media(
    app: AppHandle,
    state: State<'_, Arc<AppCtx>>,
) -> Result<(), String> {
    // Clone the mount path under the lock so the lock isn't held for
    // the (potentially long) walk — keeps any concurrent unmount /
    // command from blocking.
    let mount = {
        let g = state.mount.lock().await;
        g.as_ref().cloned()
    };
    let Some(mount) = mount else {
        return Err("iPhone not mounted".into());
    };
    device::list_media(&mount, &app).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn thumb_for(path: String) -> Result<String, String> {
    thumbs::thumb_data_url(std::path::Path::new(&path))
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn import_files(
    paths: Vec<String>,
    dest: String,
    app: AppHandle,
) -> Result<(), String> {
    let dest_pb = std::path::PathBuf::from(&dest);
    let result = import::run(paths, dest_pb, app).await;
    // Remember destination on success so the picker opens there next time.
    if result.is_ok() {
        let mut s = settings::load();
        s.last_destination = Some(dest);
        let _ = settings::save(&s);
    }
    result.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn load_settings() -> settings::Settings {
    settings::load()
}

#[tauri::command]
async fn unmount_device(state: State<'_, Arc<AppCtx>>) -> Result<(), String> {
    let prev = state.mount.lock().await.take();
    if let Some(p) = prev {
        device::unmount(&p).await.map_err(|e| format!("{e:#}"))?;
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
            check_environment,
            probe_device,
            mount_device,
            list_media,
            thumb_for,
            import_files,
            load_settings,
            unmount_device,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
