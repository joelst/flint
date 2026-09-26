#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePhase {
    Stopped,
    Starting,
    Ready,
    ShuttingDown,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeState {
    generation: u64,
    phase: RuntimePhase,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            generation: 0,
            phase: RuntimePhase::Stopped,
        }
    }
}

impl RuntimeState {
    pub fn generation(self) -> u64 {
        self.generation
    }

    pub fn phase(self) -> RuntimePhase {
        self.phase
    }

    pub fn begin_start(&mut self) -> Option<u64> {
        if !matches!(self.phase, RuntimePhase::Stopped | RuntimePhase::Exited) {
            return None;
        }
        self.generation = self.generation.checked_add(1)?;
        self.phase = RuntimePhase::Starting;
        Some(self.generation)
    }

    pub fn mark_ready(&mut self, generation: u64) -> bool {
        if self.generation != generation || self.phase != RuntimePhase::Starting {
            return false;
        }
        self.phase = RuntimePhase::Ready;
        true
    }

    pub fn begin_shutdown(&mut self, generation: u64) -> bool {
        if self.generation != generation
            || !matches!(
                self.phase,
                RuntimePhase::Starting | RuntimePhase::Ready | RuntimePhase::ShuttingDown
            )
        {
            return false;
        }
        self.phase = RuntimePhase::ShuttingDown;
        true
    }

    pub fn observe_exit(&mut self, generation: u64) -> bool {
        if self.generation != generation
            || !matches!(
                self.phase,
                RuntimePhase::Starting | RuntimePhase::Ready | RuntimePhase::ShuttingDown
            )
        {
            return false;
        }
        self.phase = RuntimePhase::Exited;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{RuntimePhase, RuntimeState};

    #[test]
    fn generation_rejects_stale_readiness_and_exit() {
        let mut state = RuntimeState::default();
        let first = state.begin_start().expect("first generation");
        assert!(state.mark_ready(first));
        assert!(state.begin_shutdown(first));
        assert!(state.observe_exit(first));

        let second = state.begin_start().expect("second generation");
        assert_ne!(first, second);
        assert!(!state.mark_ready(first));
        assert!(!state.observe_exit(first));
        assert_eq!(state.phase(), RuntimePhase::Starting);
        assert!(state.mark_ready(second));
    }

    #[test]
    fn transitions_require_the_expected_phase() {
        let mut state = RuntimeState::default();
        assert!(state.begin_start().is_some());
        assert!(state.begin_start().is_none());
        assert!(!state.begin_shutdown(99));
        assert!(state.observe_exit(state.generation()));
        assert!(!state.observe_exit(state.generation()));
        let generation = state.begin_start().expect("restart generation");
        assert!(!state.begin_shutdown(generation.saturating_sub(1)));
        assert!(state.mark_ready(generation));
        assert!(state.begin_shutdown(generation));
        assert!(state.observe_exit(generation));
        assert!(!state.begin_shutdown(generation));
    }

    #[test]
    fn generation_exhaustion_fails_closed() {
        let mut state = RuntimeState {
            generation: u64::MAX,
            phase: RuntimePhase::Exited,
        };
        assert!(state.begin_start().is_none());
        assert_eq!(state.generation(), u64::MAX);
        assert_eq!(state.phase(), RuntimePhase::Exited);
    }
}
