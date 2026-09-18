pub mod quit_flush;
pub mod runtime_child;
pub mod runtime_manager;
pub mod runtime_state;
pub mod runtime_supervisor;
pub mod runtime_transport;
pub mod tray;

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(runtime_manager::NativeRuntime::default())
        .manage(quit_flush::QuitFlushState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main_window(app);
        }))
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
            quit_app,
            relaunch_app,
            quit_flush::ack_quit_flush,
        ])
        .setup(|app| {
            if let Err(error) = tray::install(app.handle()) {
                // Close-to-hide has no Open/Quit without the native tray. Do not start
                // a hidden-window app with no recovery control.
                eprintln!("[flint] native tray unavailable: {error}");
                return Err(error.into());
            }
            if std::env::var("FLINT_RUNTIME_SMOKE").ok().as_deref() == Some("1") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    use tauri::Manager as _;
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
                    loop {
                        let phase = handle.state::<runtime_manager::NativeRuntime>().phase();
                        match phase {
                            runtime_state::RuntimePhase::Ready => {
                                eprintln!("[flint] runtime smoke: ready");
                                handle.exit(0);
                                return;
                            }
                            runtime_state::RuntimePhase::Exited => {
                                eprintln!("[flint] runtime smoke: runtime exited before ready");
                                handle.exit(1);
                                return;
                            }
                            _ => {}
                        }
                        if std::time::Instant::now() > deadline {
                            eprintln!("[flint] runtime smoke: timed out waiting for ready");
                            handle.exit(1);
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        use tauri::Manager as _;

        match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                let is_restart = code == Some(tauri::RESTART_EXIT_CODE);
                quit_flush::on_exit_requested(app_handle, &api, is_restart);
            }
            tauri::RunEvent::Exit => {
                runtime_manager::stop_for_app_exit(
                    app_handle
                        .state::<runtime_manager::NativeRuntime>()
                        .inner(),
                );
            }
            // Close-to-tray hides the window rather than destroying it. macOS then reports no
            // visible windows, and clicking the Dock icon only raises `Reopen` — nothing restores
            // the window unless we do it here, so without this the app looks permanently gone.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                tray::show_main_window(app_handle);
            }
            _ => {}
        }
    });
}
