/** One sweep at a time; a timed-out operation stays owned until it settles. */
export function createHeartbeat({ entries, run, onError, budgetMs = 10_000 }) {
  const pending = new Map();
  let current, disposed = false;
  const counts = { sweeps: 0, completed: 0, failed: 0, timedOut: 0 };
  return {
    sweep() {
      if (disposed) return Promise.resolve();
      if (current !== undefined) return current;
      counts.sweeps++;
      current = (async () => {
        for (const entry of entries()) {
          if (disposed) break;
          const key = `${entry.workspace}\0${entry.teamId}`;
          if (pending.has(key)) continue; // Never enqueue behind hung I/O.
          const controller = new AbortController();
          pending.set(key, controller);
          let timer, aborted;
          const work = Promise.resolve().then(() => run(entry, controller.signal))
            .finally(() => pending.delete(key));
          const deadline = new Promise((_, reject) => {
            aborted = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', aborted, { once: true });
            timer = setTimeout(() => controller.abort(new Error('team heartbeat deadline exceeded')), budgetMs);
          });
          try { await Promise.race([work, deadline]); counts.completed++; }
          catch (error) {
            if (!disposed) {
              counts.failed++;
              if (controller.signal.aborted) counts.timedOut++;
              onError(entry, error);
            }
          }
          finally { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); }
        }
      })().finally(() => { current = undefined; });
      return current;
    },
    dispose() {
      disposed = true;
      for (const controller of pending.values()) controller.abort(new Error('scheduler disposed'));
    },
    health() { return { ...counts, pending: pending.size, disposed }; },
  };
}
