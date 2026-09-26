use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// Frontend listens for this, flushes conversations, then invokes `ack_quit_flush`.
pub const QUIT_FLUSH_EVENT: &str = "flint-quit-flush";
/// If the renderer is dead or hung, quit anyway. localStorage write is synchronous and short.
pub const QUIT_FLUSH_TIMEOUT: Duration = Duration::from_millis(2_000);

pub struct QuitFlushState {
    allow_exit: AtomicBool,
    started: AtomicBool,
    exit_code: AtomicI32,
}

impl Default for QuitFlushState {
    fn default() -> Self {
        Self {
            allow_exit: AtomicBool::new(false),
            started: AtomicBool::new(false),
            exit_code: AtomicI32::new(0),
        }
    }
}

fn is_runtime_smoke() -> bool {
    std::env::var("FLINT_RUNTIME_SMOKE").ok().as_deref() == Some("1")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitFlushDecision {
    /// Let this ExitRequested through (ack already happened, or this is a restart).
    Allow,
    /// First request: prevent exit and ask the frontend to flush.
    PreventStartFlush,
    /// Flush already in flight; keep preventing until ack or timeout.
    PreventAlreadyStarted,
}

pub fn decide_exit_flush(allow_exit: bool, started: bool, is_restart: bool) -> ExitFlushDecision {
    if is_restart || allow_exit {
        return ExitFlushDecision::Allow;
    }
    if started {
        return ExitFlushDecision::PreventAlreadyStarted;
    }
    ExitFlushDecision::PreventStartFlush
}

pub fn on_exit_requested(
    app: &AppHandle,
    api: &tauri::ExitRequestApi,
    is_restart: bool,
    code: Option<i32>,
) {
    // Packaged smoke exits 0/1 to report ready vs failure. A flush handshake that
    // always finishes with exit(0) would make those failures look successful.
    if is_runtime_smoke() {
        return;
    }
    let state = app.state::<QuitFlushState>();
    let allow = state.allow_exit.load(Ordering::SeqCst);
    let started = state.started.load(Ordering::SeqCst);
    match decide_exit_flush(allow, started, is_restart) {
        ExitFlushDecision::Allow => {}
        ExitFlushDecision::PreventAlreadyStarted => {
            api.prevent_exit();
        }
        ExitFlushDecision::PreventStartFlush => {
            api.prevent_exit();
            if let Some(code) = code {
                state.exit_code.store(code, Ordering::SeqCst);
            }
            state.started.store(true, Ordering::SeqCst);
            let _ = app.emit(QUIT_FLUSH_EVENT, ());
            let handle = app.clone();
            thread::spawn(move || {
                thread::sleep(QUIT_FLUSH_TIMEOUT);
                let state = handle.state::<QuitFlushState>();
                if !state.allow_exit.swap(true, Ordering::SeqCst) {
                    let code = state.exit_code.load(Ordering::SeqCst);
                    handle.exit(code);
                }
            });
        }
    }
}

#[tauri::command]
pub fn ack_quit_flush(app: AppHandle, state: tauri::State<QuitFlushState>) {
    let code = state.exit_code.load(Ordering::SeqCst);
    state.allow_exit.store(true, Ordering::SeqCst);
    app.exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_and_acked_exit_are_allowed() {
        assert_eq!(
            decide_exit_flush(false, false, true),
            ExitFlushDecision::Allow
        );
        assert_eq!(
            decide_exit_flush(true, true, false),
            ExitFlushDecision::Allow
        );
    }

    #[test]
    fn first_request_starts_a_flush() {
        assert_eq!(
            decide_exit_flush(false, false, false),
            ExitFlushDecision::PreventStartFlush
        );
    }

    #[test]
    fn a_second_request_while_flushing_still_prevents() {
        assert_eq!(
            decide_exit_flush(false, true, false),
            ExitFlushDecision::PreventAlreadyStarted
        );
    }
}
