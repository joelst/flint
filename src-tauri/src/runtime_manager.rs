use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;

use crate::runtime_state::RuntimePhase;
use crate::runtime_supervisor::{RuntimeStart, RuntimeSupervisor};
use crate::runtime_transport::{encode_json_line, JsonLinesDecoder};

const MAX_RUNTIME_FRAME_BYTES: usize = 80 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 64 * 1024;

pub struct NativeRuntime {
    supervisor: Mutex<RuntimeSupervisor>,
    terminal: AtomicBool,
}

impl Default for NativeRuntime {
    fn default() -> Self {
        Self {
            supervisor: Mutex::new(RuntimeSupervisor::default()),
            terminal: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    generation: u64,
    phase: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStartResult {
    generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeMessageEvent {
    generation: u64,
    message: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTextEvent {
    generation: u64,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeExitEvent {
    generation: u64,
    code: Option<i32>,
}

fn phase_name(phase: RuntimePhase) -> &'static str {
    match phase {
        RuntimePhase::Stopped => "stopped",
        RuntimePhase::Starting => "starting",
        RuntimePhase::Ready => "ready",
        RuntimePhase::ShuttingDown => "shuttingDown",
        RuntimePhase::Exited => "exited",
    }
}

fn trusted_runtime_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, String), String> {
    #[cfg(debug_assertions)]
    let _ = app;

    #[cfg(debug_assertions)]
    let base_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "Cargo manifest directory has no repository parent".to_string())?
        .to_path_buf();

    #[cfg(not(debug_assertions))]
    let base_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve the resource directory: {error}"))?;

    let script = base_dir.join("sidecar").join("foundry-sidecar.js");
    let canonical_base = base_dir
        .canonicalize()
        .map_err(|error| format!("Could not open runtime base directory: {error}"))?;
    let canonical_script = script
        .canonicalize()
        .map_err(|error| format!("Could not open the packaged sidecar: {error}"))?;
    if !canonical_script.starts_with(&canonical_base) {
        return Err("The sidecar resolved outside Flint's trusted runtime directory".to_string());
    }

    #[cfg(debug_assertions)]
    let node_path =
        std::env::join_paths([canonical_base.join("node_modules"), canonical_base.clone()])
            .map_err(|error| format!("Could not build development NODE_PATH: {error}"))?;

    #[cfg(not(debug_assertions))]
    let node_path = std::env::join_paths([canonical_base.clone()])
        .map_err(|error| format!("Could not build packaged NODE_PATH: {error}"))?;

    Ok((
        canonical_script,
        canonical_base,
        node_path.to_string_lossy().into_owned(),
    ))
}

fn runtime_command(
    app: &AppHandle,
    node_mode: &str,
    script: &Path,
    base_dir: &Path,
    node_path: &str,
) -> Result<Command, String> {
    let command = match node_mode {
        "bundled" => app
            .shell()
            .sidecar("node")
            .map_err(|error| format!("Could not resolve bundled Node: {error}"))?,
        "path" => app.shell().command("node"),
        _ => return Err("Node mode must be 'bundled' or 'path'".to_string()),
    };
    Ok(command
        .arg(script)
        .current_dir(base_dir)
        .env("NODE_PATH", node_path)
        .into())
}

fn emit_error(app: &AppHandle, generation: u64, error: impl Into<String>) {
    let _ = app.emit(
        "flint://runtime-error",
        RuntimeTextEvent {
            generation,
            text: error.into(),
        },
    );
}

fn start_event_threads(app: AppHandle, started: RuntimeStart) {
    let generation = started.generation;
    let mut stdout = started.pipes.stdout;
    let mut stderr = started.pipes.stderr;
    let stdout_app = app.clone();
    let stdout_reader = thread::spawn(move || {
        let mut decoder = match JsonLinesDecoder::new(MAX_RUNTIME_FRAME_BYTES) {
            Ok(decoder) => decoder,
            Err(error) => {
                emit_error(&stdout_app, generation, error.to_string());
                return;
            }
        };
        let mut bytes = vec![0; READ_CHUNK_BYTES];
        loop {
            match stdout.read(&mut bytes) {
                Ok(0) => {
                    if let Err(error) = decoder.finish() {
                        emit_error(&stdout_app, generation, error.to_string());
                    }
                    return;
                }
                Ok(count) => match decoder.push(&bytes[..count]) {
                    Ok(messages) => {
                        for message in messages {
                            let _ = stdout_app.emit(
                                "flint://runtime-stdout",
                                RuntimeMessageEvent {
                                    generation,
                                    message,
                                },
                            );
                        }
                    }
                    Err(error) => {
                        emit_error(&stdout_app, generation, error.to_string());
                        return;
                    }
                },
                Err(error) => {
                    emit_error(&stdout_app, generation, error.to_string());
                    return;
                }
            }
        }
    });
    let stderr_app = app.clone();
    let stderr_reader = thread::spawn(move || {
        let mut bytes = vec![0; READ_CHUNK_BYTES];
        loop {
            match stderr.read(&mut bytes) {
                Ok(0) => return,
                Ok(count) => {
                    let _ = stderr_app.emit(
                        "flint://runtime-stderr",
                        RuntimeTextEvent {
                            generation,
                            text: String::from_utf8_lossy(&bytes[..count]).into_owned(),
                        },
                    );
                }
                Err(error) => {
                    emit_error(&stderr_app, generation, error.to_string());
                    return;
                }
            }
        }
    });

    let monitor_app = app;
    thread::spawn(move || loop {
        let exit = {
            let state = monitor_app.state::<NativeRuntime>();
            let mut supervisor = state
                .supervisor
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if supervisor.generation() != generation {
                return;
            }
            match supervisor.poll_exit() {
                Ok(exit) => exit,
                Err(error) => {
                    emit_error(&monitor_app, generation, error.to_string());
                    return;
                }
            }
        };
        if let Some(exit) = exit {
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let _ = monitor_app.emit(
                "flint://runtime-exit",
                RuntimeExitEvent {
                    generation,
                    code: exit.code,
                },
            );
            return;
        }
        thread::sleep(Duration::from_millis(25));
    });
}

#[tauri::command]
pub fn runtime_status(state: State<'_, NativeRuntime>) -> RuntimeStatus {
    let supervisor = state
        .supervisor
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    RuntimeStatus {
        generation: supervisor.generation(),
        phase: phase_name(supervisor.phase()),
    }
}

#[tauri::command]
pub fn runtime_start(
    app: AppHandle,
    state: State<'_, NativeRuntime>,
    node_mode: String,
) -> Result<RuntimeStartResult, String> {
    if state.terminal.load(Ordering::Acquire) {
        return Err("The native runtime supervisor is shutting down".to_string());
    }
    let (script, base_dir, node_path) = trusted_runtime_paths(&app)?;
    let command = runtime_command(&app, &node_mode, &script, &base_dir, &node_path)?;
    let started = {
        let mut supervisor = state
            .supervisor
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        supervisor
            .start_command(command)
            .map_err(|error| format!("Could not start the runtime: {error}"))?
    };
    let generation = started.generation;
    start_event_threads(app, started);
    Ok(RuntimeStartResult { generation })
}

#[tauri::command]
pub fn runtime_mark_ready(state: State<'_, NativeRuntime>, generation: u64) -> bool {
    let mut supervisor = state
        .supervisor
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    supervisor.mark_ready(generation)
}

#[tauri::command]
pub fn runtime_write(
    state: State<'_, NativeRuntime>,
    generation: u64,
    message: Value,
) -> Result<(), String> {
    let bytes = encode_json_line(&message, MAX_RUNTIME_FRAME_BYTES)
        .map_err(|error| format!("Could not encode runtime message: {error}"))?;
    let writer = {
        let supervisor = state
            .supervisor
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        supervisor
            .writer(generation)
            .ok_or_else(|| "The requested runtime generation is not active".to_string())?
    };
    writer
        .write(bytes)
        .map_err(|error| format!("Could not write to the runtime: {error}"))
}

#[tauri::command]
pub fn runtime_force_stop(
    state: State<'_, NativeRuntime>,
    generation: u64,
) -> Result<bool, String> {
    let mut supervisor = state
        .supervisor
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    supervisor
        .request_shutdown(generation)
        .map_err(|error| format!("Could not terminate the runtime: {error}"))
}

pub fn stop_for_app_exit(state: &NativeRuntime) {
    state.terminal.store(true, Ordering::Release);
    let mut supervisor = state
        .supervisor
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let generation = supervisor.generation();
    let _ = supervisor.shutdown(generation);
}
