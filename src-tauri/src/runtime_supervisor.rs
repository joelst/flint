use std::io;

use crate::runtime_child::{ChildExit, RuntimeChild};
use crate::runtime_state::{RuntimePhase, RuntimeState};

pub struct RuntimeSupervisor {
    state: RuntimeState,
    child: Option<RuntimeChild>,
}

impl Default for RuntimeSupervisor {
    fn default() -> Self {
        Self {
            state: RuntimeState::default(),
            child: None,
        }
    }
}

impl RuntimeSupervisor {
    pub fn phase(&self) -> RuntimePhase {
        self.state.phase()
    }

    pub fn generation(&self) -> u64 {
        self.state.generation()
    }

    pub fn start<P, I, S>(&mut self, program: P, args: I) -> io::Result<u64>
    where
        P: AsRef<std::ffi::OsStr>,
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let generation = self.state.begin_start().ok_or_else(|| {
            io::Error::new(io::ErrorKind::AlreadyExists, "runtime child already active")
        })?;
        match RuntimeChild::spawn(generation, program, args) {
            Ok(child) => {
                self.child = Some(child);
                Ok(generation)
            }
            Err(error) => {
                let _ = self.state.observe_exit(generation);
                Err(error)
            }
        }
    }

    pub fn mark_ready(&mut self, generation: u64) -> bool {
        self.state.mark_ready(generation)
    }

    pub fn poll_exit(&mut self) -> io::Result<Option<ChildExit>> {
        let Some(child) = self.child.as_mut() else {
            return Ok(None);
        };
        let exit = child.try_wait()?;
        if let Some(exit) = exit {
            let _ = self.state.observe_exit(exit.generation);
            self.child = None;
            return Ok(Some(exit));
        }
        Ok(None)
    }

    pub fn shutdown(&mut self, generation: u64) -> io::Result<Option<ChildExit>> {
        if !self.state.begin_shutdown(generation) {
            return Ok(None);
        }
        let Some(child) = self.child.as_mut() else {
            let _ = self.state.observe_exit(generation);
            return Ok(None);
        };
        child.terminate()?;
        let exit = child.wait()?;
        self.child = None;
        let _ = self.state.observe_exit(exit.generation);
        Ok(Some(exit))
    }
}

#[cfg(test)]
mod tests {
    use super::{RuntimePhase, RuntimeSupervisor};
    use std::time::{Duration, Instant};

    fn command() -> (&'static str, Vec<&'static str>) {
        if cfg!(windows) {
            ("cmd", vec!["/C", "exit 0"])
        } else {
            ("sh", vec!["-c", "exit 0"])
        }
    }

    fn long_command() -> (&'static str, Vec<&'static str>) {
        if cfg!(windows) {
            ("ping", vec!["-n", "30", "127.0.0.1"])
        } else {
            ("sleep", vec!["30"])
        }
    }

    #[test]
    fn admits_one_child_and_requires_its_generation() {
        let (program, args) = long_command();
        let mut supervisor = RuntimeSupervisor::default();
        let generation = supervisor.start(program, args).expect("start child");
        assert_eq!(supervisor.phase(), RuntimePhase::Starting);
        assert!(supervisor.start(program, Vec::<&str>::new()).is_err());
        assert!(!supervisor.mark_ready(generation.saturating_sub(1)));
        assert!(supervisor.mark_ready(generation));
        let exit = supervisor.shutdown(generation).expect("shutdown child");
        assert!(exit.is_some());
        assert_eq!(supervisor.phase(), RuntimePhase::Exited);
    }

    #[test]
    fn observes_exit_and_allows_a_new_generation() {
        let (program, args) = command();
        let mut supervisor = RuntimeSupervisor::default();
        let first = supervisor.start(program, args).expect("start child");
        let deadline = Instant::now() + Duration::from_secs(2);
        let exit = loop {
            if let Some(exit) = supervisor.poll_exit().expect("poll child") {
                break exit;
            }
            assert!(Instant::now() < deadline, "child did not exit");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(exit.generation, first);
        assert_eq!(supervisor.phase(), RuntimePhase::Exited);
        let second = supervisor
            .start(program, command().1)
            .expect("restart child");
        assert_ne!(first, second);
        assert!(supervisor
            .shutdown(second)
            .expect("shutdown child")
            .is_some());
    }

    #[test]
    fn ignores_stale_shutdown_and_handles_missing_child() {
        let mut supervisor = RuntimeSupervisor::default();
        assert_eq!(supervisor.shutdown(1).expect("stale shutdown"), None);

        let generation = supervisor
            .start(command().0, command().1)
            .expect("start child");
        let mut child = supervisor.child.take().expect("child handle");
        child.wait().expect("wait child");
        assert_eq!(
            supervisor.shutdown(generation).expect("missing child"),
            None
        );
        assert_eq!(supervisor.phase(), RuntimePhase::Exited);
    }
}
