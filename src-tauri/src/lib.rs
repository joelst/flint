pub mod runtime_child;
pub mod runtime_manager;
pub mod runtime_state;
pub mod runtime_supervisor;
pub mod runtime_transport;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(runtime_manager::NativeRuntime::default())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager as _;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            runtime_manager::runtime_status,
            runtime_manager::runtime_start,
            runtime_manager::runtime_mark_ready,
            runtime_manager::runtime_write,
            runtime_manager::runtime_force_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        if matches!(
            _event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            use tauri::Manager as _;

            runtime_manager::stop_for_app_exit(
                _app_handle
                    .state::<runtime_manager::NativeRuntime>()
                    .inner(),
            );
        }

        // Close-to-tray hides the window rather than destroying it. macOS then reports no
        // visible windows, and clicking the Dock icon only raises `Reopen` — nothing restores
        // the window unless we do it here, so without this the app looks permanently gone.
        #[cfg(target_os = "macos")]
        {
            use tauri::Manager as _;

            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = _event
            {
                if !has_visible_windows {
                    for (_label, window) in _app_handle.webview_windows() {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
        }
    });
}
