use serde_json::Value;
#[cfg(debug_assertions)]
use std::path::Path;
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
#[cfg(not(debug_assertions))]
use tauri::Manager as _;
use tauri_plugin_shell::ShellExt as _;

const MAX_INPUT_BYTES: usize = 16 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_ERROR_BYTES: usize = 16 * 1024;
const HELPER_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONCURRENT_HELPERS: usize = 2;
static ACTIVE_HELPERS: AtomicUsize = AtomicUsize::new(0);

struct HelperPermit;

impl HelperPermit {
    fn acquire() -> Result<Self, String> {
        let mut active = ACTIVE_HELPERS.load(Ordering::Acquire);
        loop {
            if active >= MAX_CONCURRENT_HELPERS {
                return Err("Too many web requests are already running".to_string());
            }
            match ACTIVE_HELPERS.compare_exchange_weak(
                active,
                active + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(Self),
                Err(current) => active = current,
            }
        }
    }
}

impl Drop for HelperPermit {
    fn drop(&mut self) {
        ACTIVE_HELPERS.fetch_sub(1, Ordering::AcqRel);
    }
}

struct KillOnDropChild(Child);

impl Drop for KillOnDropChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn trusted_helper_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
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

    let canonical_base = base_dir
        .canonicalize()
        .map_err(|error| format!("Could not open web tool base directory: {error}"))?;
    let canonical_script = canonical_base
        .join("sidecar")
        .join("web-tool.js")
        .canonicalize()
        .map_err(|error| format!("Could not open the packaged web tool: {error}"))?;
    if !canonical_script.starts_with(&canonical_base) {
        return Err("The web tool resolved outside Flint's trusted resource directory".to_string());
    }
    Ok((canonical_script, canonical_base))
}

fn read_capped<R: Read>(mut reader: R, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read web tool output: {error}"))?;
    if bytes.len() > limit {
        return Err("Web tool output exceeded its byte limit".to_string());
    }
    Ok(bytes)
}

fn minimal_environment(command: &mut Command) {
    command.env_clear();
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

fn run_helper(command: Command, input: Vec<u8>) -> Result<Value, String> {
    run_helper_with_timeout(command, input, HELPER_TIMEOUT)
}

fn run_helper_with_timeout(
    mut command: Command,
    input: Vec<u8>,
    timeout: Duration,
) -> Result<Value, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    minimal_environment(&mut command);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x08000000);
    }

    let mut child = KillOnDropChild(
        command
            .spawn()
            .map_err(|error| format!("Could not start the web tool: {error}"))?,
    );
    // One deadline covers request delivery and execution: a child that stalls before
    // draining stdin must not hold this task (and its concurrency permit) indefinitely.
    let deadline = Instant::now() + timeout;
    let Some(mut stdin) = child.0.stdin.take() else {
        return Err("Web tool stdin was unavailable".to_string());
    };
    let Some(stdout) = child.0.stdout.take() else {
        return Err("Web tool stdout was unavailable".to_string());
    };
    let Some(stderr) = child.0.stderr.take() else {
        return Err("Web tool stderr was unavailable".to_string());
    };

    let stdin_writer = thread::spawn(move || {
        stdin.write_all(&input).and_then(|_| stdin.flush())
        // Dropping stdin here closes the pipe so the helper sees end of input.
    });
    let stdout_reader = thread::spawn(move || read_capped(stdout, MAX_OUTPUT_BYTES));
    let stderr_reader = thread::spawn(move || read_capped(stderr, MAX_ERROR_BYTES));

    let status = loop {
        if let Some(status) = child
            .0
            .try_wait()
            .map_err(|error| format!("Could not inspect the web tool: {error}"))?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.0.kill();
            let _ = child.0.wait();
            let _ = stdin_writer.join();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err("Web tool request timed out".to_string());
        }
        thread::sleep(Duration::from_millis(25));
    };

    let write_result = stdin_writer
        .join()
        .map_err(|_| "Web tool stdin writer panicked".to_string())?;
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Web tool stdout reader panicked".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Web tool stderr reader panicked".to_string())??;
    // A helper that fails before writing its frame (for example, a module load error)
    // leaves its only diagnostic on stderr, so every failure carries it.
    let with_stderr = |message: String| {
        let stderr = String::from_utf8_lossy(&stderr);
        let stderr = stderr.trim();
        if stderr.is_empty() {
            message
        } else {
            format!("{message} ({stderr})")
        }
    };
    if let Err(error) = write_result {
        return Err(with_stderr(format!(
            "Could not send the web tool request: {error}"
        )));
    }
    let frame: Value = serde_json::from_slice(&stdout)
        .map_err(|error| with_stderr(format!("Web tool returned invalid JSON: {error}")))?;
    if !status.success() || frame.get("ok").and_then(Value::as_bool) != Some(true) {
        let reported = frame
            .get("error")
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .unwrap_or("Web tool request failed");
        return Err(with_stderr(reported.to_string()));
    }
    frame
        .get("result")
        .cloned()
        .ok_or_else(|| "Web tool response did not include a result".to_string())
}

#[tauri::command]
pub async fn web_tool_execute(app: AppHandle, request: Value) -> Result<Value, String> {
    let input = serde_json::to_vec(&request)
        .map_err(|error| format!("Could not encode web tool request: {error}"))?;
    if input.len() > MAX_INPUT_BYTES {
        return Err("Web tool request exceeded its byte limit".to_string());
    }
    let (script, base_dir) = trusted_helper_paths(&app)?;
    let shell_command = app
        .shell()
        .sidecar("node")
        .map_err(|error| format!("Could not resolve bundled Node for the web tool: {error}"))?;
    let command: Command = shell_command.arg(script).current_dir(base_dir).into();
    let permit = HelperPermit::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        run_helper(command, input)
    })
    .await
    .map_err(|error| format!("Web tool task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(script: &str) -> Command {
        let mut command = Command::new("node");
        command.arg("-e").arg(script);
        command
    }

    #[test]
    fn deadline_covers_a_child_that_never_drains_stdin() {
        let started = Instant::now();
        let result = run_helper_with_timeout(
            node("setInterval(() => {}, 1000)"),
            vec![b' '; 4 * 1024 * 1024],
            Duration::from_millis(1500),
        );
        assert_eq!(result.unwrap_err(), "Web tool request timed out");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn keeps_stderr_when_the_child_fails_before_writing_a_frame() {
        let error = run_helper_with_timeout(
            node("process.stderr.write('helper failed to load'); process.exit(1)"),
            b"{}".to_vec(),
            Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(error.contains("helper failed to load"), "{error}");
    }

    #[test]
    fn keeps_stderr_when_a_drained_child_writes_invalid_json() {
        let error = run_helper_with_timeout(
            node(
                "process.stdin.resume(); process.stdin.on('end', () => { \
                 process.stderr.write('bad frame'); process.stdout.write('nope'); process.exitCode = 1; })",
            ),
            b"{}".to_vec(),
            Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(
            error.starts_with("Web tool returned invalid JSON"),
            "{error}"
        );
        assert!(error.ends_with("(bad frame)"), "{error}");
    }

    #[test]
    fn returns_the_result_of_a_successful_frame() {
        let value = run_helper_with_timeout(
            node(
                "let n = 0; process.stdin.on('data', (c) => { n += c.length; }); \
                 process.stdin.on('end', () => process.stdout.write(JSON.stringify({ ok: true, result: n })))",
            ),
            vec![b'x'; 64 * 1024],
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(value, serde_json::json!(65536));
    }
}
