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
}

impl RuntimeChild {
    pub fn spawn<I, S>(generation: u64, program: &str, args: I) -> io::Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let child = Command::new(program).args(args).spawn()?;
        Ok(Self { generation, child })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ChildExit>> {
        self.child.try_wait().map(|status| {
            status.map(|status| ChildExit {
                generation: self.generation,
                code: status.code(),
            })
        })
    }

    pub fn terminate(&mut self) -> io::Result<()> {
        self.child.kill()
    }

    pub fn wait(&mut self) -> io::Result<ChildExit> {
        self.child.wait().map(|status| ChildExit {
            generation: self.generation,
            code: status.code(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimeChild;

    #[test]
    fn reports_generation_on_exit() {
        let mut child = RuntimeChild::spawn(42, if cfg!(windows) { "cmd" } else { "sh" }, if cfg!(windows) {
            vec!["/C", "exit 7"]
        } else {
            vec!["-c", "exit 7"]
        })
        .expect("spawn test child");

        let exit = child.wait().expect("wait for test child");
        assert_eq!(exit.generation, 42);
        assert_eq!(exit.code, Some(7));
    }

    #[test]
    fn termination_is_explicit_and_observable() {
        let mut child = RuntimeChild::spawn(7, if cfg!(windows) { "ping" } else { "sleep" }, if cfg!(windows) {
            vec!["-n", "30", "127.0.0.1"]
        } else {
            vec!["30"]
        })
        .expect("spawn long-lived test child");

        child.terminate().expect("terminate test child");
        let exit = child.wait().expect("wait for terminated child");
        assert_eq!(exit.generation, 7);
        assert_ne!(exit.code, Some(0));
    }
}
