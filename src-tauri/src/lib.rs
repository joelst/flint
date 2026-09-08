#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
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
