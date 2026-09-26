export const DEFAULT_PROGRESS_STALL_MS = 60_000;

export type ProgressStallWatchdog = {
  start: () => void;
  progress: () => void;
  stop: () => void;
};

export function createProgressStallWatchdog(
  onStall: () => void,
  stallAfterMs = DEFAULT_PROGRESS_STALL_MS,
): ProgressStallWatchdog {
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const arm = () => {
    clear();
    if (!active) return;
    timer = setTimeout(() => {
      timer = null;
      if (active) onStall();
    }, stallAfterMs);
  };

  return {
    start() {
      active = true;
      arm();
    },
    progress() {
      if (active) arm();
    },
    stop() {
      active = false;
      clear();
    },
  };
}
