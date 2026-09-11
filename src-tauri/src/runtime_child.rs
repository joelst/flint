use std::io;
use std::process::{Child, Command};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChildExit {
    pub generation: u64,
    pub code: Option<i32>,
}

pub struct RuntimeChild {
    generation: u64,
    child: Child,
    exit: Option<ChildExit>,
}

impl RuntimeChild {
    pub fn spawn<P, I, S>(generation: u64, program: P, args: I) -> io::Result<Self>
    where
        P: AsRef<std::ffi::OsStr>,
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let child = Command::new(program).args(args).spawn()?;
        Ok(Self {
            generation,
            child,
            exit: None,
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ChildExit>> {
        if self.exit.is_some() {
            return Ok(self.exit);
        }
        self.child.try_wait().map(|status| {
            status.map(|status| {
                let exit = ChildExit {
                    generation: self.generation,
                    code: status.code(),
                };
                self.exit = Some(exit);
                exit
            })
        })
    }

    pub fn terminate(&mut self) -> io::Result<()> {
        if self.exit.is_some() {
            return Ok(());
        }
        match self.child.kill() {
            Ok(()) => Ok(()),
            Err(error) => match self.try_wait() {
                Ok(Some(_)) => Ok(()),
                _ => Err(error),
            },
        }
    }

    pub fn wait(&mut self) -> io::Result<ChildExit> {
        if let Some(exit) = self.exit {
            return Ok(exit);
        }
        self.child.wait().map(|status| {
            let exit = ChildExit {
                generation: self.generation,
                code: status.code(),
            };
            self.exit = Some(exit);
            exit
        })
    }
}

impl Drop for RuntimeChild {
    fn drop(&mut self) {
        if self.exit.is_none() && !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimeChild;
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn process_exists(pid: u32) -> bool {
        #[cfg(unix)]
        {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }
        #[cfg(windows)]
        {
            Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .output()
                .map(|output| {
                    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
                        line.split(',')
                            .nth(1)
                            .map(|field| field.trim_matches('"') == pid.to_string())
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        }
    }

    #[test]
    fn reports_generation_on_exit() {
        let mut child = RuntimeChild::spawn(
            42,
            if cfg!(windows) { "cmd" } else { "sh" },
            if cfg!(windows) {
                vec!["/C", "exit 7"]
            } else {
                vec!["-c", "exit 7"]
            },
        )
        .expect("spawn test child");

        let exit = child.wait().expect("wait for test child");
        assert_eq!(exit.generation, 42);
        assert_eq!(exit.code, Some(7));
    }

    #[test]
    fn termination_is_explicit_and_observable() {
        let mut child = RuntimeChild::spawn(
            7,
            if cfg!(windows) { "ping" } else { "sleep" },
            if cfg!(windows) {
                vec!["-n", "30", "127.0.0.1"]
            } else {
                vec!["30"]
            },
        )
        .expect("spawn long-lived test child");

        child.terminate().expect("terminate test child");
        let exit = child.wait().expect("wait for terminated child");
        assert_eq!(exit.generation, 7);
        assert_ne!(exit.code, Some(0));
    }

    #[test]
    fn try_wait_distinguishes_live_and_exited_children() {
        let mut child = RuntimeChild::spawn(
            9,
            if cfg!(windows) { "ping" } else { "sleep" },
            if cfg!(windows) {
                vec!["-n", "30", "127.0.0.1"]
            } else {
                vec!["30"]
            },
        )
        .expect("spawn long-lived test child");

        assert!(child.try_wait().expect("poll live child").is_none());
        child.terminate().expect("terminate test child");
        let deadline = Instant::now() + Duration::from_secs(2);
        let exit = loop {
            if let Some(exit) = child.try_wait().expect("poll terminated child") {
                break exit;
            }
            assert!(Instant::now() < deadline, "terminated child did not exit");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(exit.generation, 9);
    }

    #[test]
    fn wait_returns_the_exit_already_observed_by_try_wait() {
        let mut child = RuntimeChild::spawn(
            11,
            if cfg!(windows) { "cmd" } else { "sh" },
            if cfg!(windows) {
                vec!["/C", "exit 3"]
            } else {
                vec!["-c", "exit 3"]
            },
        )
        .expect("spawn test child");
        let deadline = Instant::now() + Duration::from_secs(2);
        let polled = loop {
            if let Some(exit) = child.try_wait().expect("poll child") {
                break exit;
            }
            assert!(Instant::now() < deadline, "child did not exit");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(child.wait().expect("wait after poll"), polled);
    }

    #[test]
    fn terminate_is_idempotent_after_polling_exit() {
        let mut child = RuntimeChild::spawn(
            13,
            if cfg!(windows) { "cmd" } else { "sh" },
            if cfg!(windows) {
                vec!["/C", "exit 0"]
            } else {
                vec!["-c", "exit 0"]
            },
        )
        .expect("spawn test child");
        let deadline = Instant::now() + Duration::from_secs(2);
        while child.try_wait().expect("poll child").is_none() {
            assert!(Instant::now() < deadline, "child did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
        child.terminate().expect("terminate already-exited child");
    }

    #[test]
    fn dropping_live_child_does_not_wait_for_natural_exit() {
        let child = RuntimeChild::spawn(
            15,
            if cfg!(windows) { "ping" } else { "sleep" },
            if cfg!(windows) {
                vec!["-n", "30", "127.0.0.1"]
            } else {
                vec!["30"]
            },
        )
        .expect("spawn long-lived test child");
        let pid = child.child.id();
        assert!(process_exists(pid));
        let deadline = Instant::now() + Duration::from_secs(2);
        let drop_started = Instant::now();
        drop(child);
        assert!(
            drop_started.elapsed() < Duration::from_secs(2),
            "drop waited for natural exit"
        );
        while process_exists(pid) {
            assert!(Instant::now() < deadline, "dropped child still exists");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
