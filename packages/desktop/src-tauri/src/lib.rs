mod daemon;
mod ipc;

use daemon::DaemonManager;
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};

#[tauri::command]
fn ipc_call(method: String, params: Option<Value>) -> Result<Value, String> {
    ipc::send_ipc_call(&method, params.unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
fn ensure_daemon(app: AppHandle) -> Result<String, String> {
    app.state::<DaemonManager>().ensure_started(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(DaemonManager::default())
        .invoke_handler(tauri::generate_handler![ipc_call, ensure_daemon])
        .setup(|app| {
            let _ = app.state::<DaemonManager>().ensure_started(app.handle());

            let show_i =
                MenuItem::with_id(app, "show", "打开 Antigravity Orbit 控制台", true, None::<&str>)?;
            let quit_i =
                MenuItem::with_id(app, "quit", "退出 Antigravity Orbit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Antigravity Orbit")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.state::<DaemonManager>().stop();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Antigravity Orbit desktop");

    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            app_handle.state::<DaemonManager>().stop();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
