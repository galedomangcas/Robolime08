/**
 * Polls one async request without overlap: the next request is scheduled
 * only after the previous one has finished (setTimeout, never setInterval).
 * After stop(), no further request starts and a result still in flight is
 * dropped instead of being delivered.
 */

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PollerOptions<T> {
  request: () => Promise<T>;
  /** Return false to stop polling (e.g. the session became invalid). */
  onResult: (result: T) => boolean | void;
  intervalMs: number;
  timers?: Timers;
}

/** Starts immediately; returns stop(). */
export function startPolling<T>(options: PollerOptions<T>): () => void {
  const timers = options.timers ?? realTimers;
  let stopped = false;
  let handle: unknown = null;

  const tick = async () => {
    handle = null;
    let result: T;
    try {
      result = await options.request();
    } catch {
      // Requests are expected to resolve with a typed failure; a throw only skips this round.
      if (!stopped) handle = timers.setTimeout(() => void tick(), options.intervalMs);
      return;
    }
    if (stopped) return;
    if (options.onResult(result) === false) {
      stopped = true;
      return;
    }
    if (!stopped) handle = timers.setTimeout(() => void tick(), options.intervalMs);
  };

  void tick();
  return () => {
    stopped = true;
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
}
