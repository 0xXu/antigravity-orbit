mod daemon;
mod ipc;

use daemon::DaemonManager;
use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

#[tauri::command]
fn ipc_call(method: String, params: Option<Value>) -> Result<Value, String> {
    ipc::send_ipc_call(&method, params.unwrap_or_else(|| json!({})))
}

#[tauri::command]
fn ensure_daemon(app: AppHandle) -> Result<String, String> {
    app.state::<DaemonManager>().ensure_started(&app)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start_hidden = std::env::args().any(|arg| arg == "--hidden");

    let app = tauri::Builder::default()
        .manage(DaemonManager::default())
        .invoke_handler(tauri::generate_handler![ipc_call, ensure_daemon])
        .setup(move |app| {
            let _ = app.state::<DaemonManager>().ensure_started(app.handle());

            if start_hidden {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            let show_i = MenuItem::with_id(
                app,
                "show",
                "打开 Antigravity Orbit 控制台",
                true,
                None::<&str>,
            )?;
            let launch_ag_i = MenuItem::with_id(
                app,
                "launch_ag",
                "带参启动 / 聚焦 Antigravity",
                true,
                None::<&str>,
            )?;
            let sep_i = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(
                app,
                "quit",
                "退出 Antigravity Orbit",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show_i, &launch_ag_i, &sep_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Antigravity Orbit — 后台运行中")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "launch_ag" => {
                        let _ = app.state::<DaemonManager>().ensure_started(app);
                        let _ = ipc::send_ipc_call("antigravity.launch", json!({}));
                    }
                    "quit" => {
                        app.state::<DaemonManager>().stop();
                        app.exit(0);
                    }
                    _ => {}
                });

            #[cfg(target_os = "macos")]
            {
                if let Ok(template_icon) =
                    Image::from_bytes(include_bytes!("../icons/tray-template.png"))
                {
                    tray_builder = tray_builder.icon(template_icon).icon_as_template(true);
                } else if let Some(icon) = app.default_window_icon().cloned() {
                    tray_builder = tray_builder.icon(icon);
                }
            }

            #[cfg(not(target_os = "macos"))]
            {
                if let Some(icon) = app.default_window_icon().cloned() {
                    tray_builder = tray_builder.icon(icon);
                }
            }

            tray_builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Clicking the window close button hides the console to the menu bar tray
            // so the Node.js Core daemon stays alive in the background.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Antigravity Orbit desktop");

    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            app_handle.state::<DaemonManager>().stop();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            show_main_window(app_handle);
        }
        _ => {}
    });
}
