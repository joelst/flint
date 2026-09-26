/**
 * Bounded asynchronous line writer.
 *
 * The writer deliberately drops new entries when its queue is full rather than blocking the
 * caller or evicting older entries that may not have reached disk yet.
 */
export function createAsyncLogWriter({
  append,
  schedule = (callback) => setImmediate(callback),
  maxQueue = 1000,
  onError = () => {},
} = {}) {
  if (typeof append !== 'function') throw new TypeError('append must be a function');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');
  if (!Number.isInteger(maxQueue) || maxQueue < 1) {
    throw new TypeError('maxQueue must be a positive integer');
  }

  const queue = [];
  let scheduled = false;
  let drainPromise = null;
  let dropped = 0;

  const scheduleDrain = () => {
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      void drain();
    });
  };

  async function drain() {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      while (queue.length > 0) {
        const batch = queue.splice(0, queue.length);
        try {
          await append(batch.join(''));
        } catch (err) {
          onError(err);
        }
      }
    })().finally(() => {
      drainPromise = null;
      if (queue.length > 0) scheduleDrain();
    });
    return drainPromise;
  }

  return {
    write(line) {
      if (queue.length >= maxQueue) {
        dropped += 1;
        return false;
      }
      queue.push(String(line));
      scheduleDrain();
      return true;
    },
    flush() {
      return drain();
    },
    get pending() {
      return queue.length;
    },
    get dropped() {
      return dropped;
    },
  };
}
