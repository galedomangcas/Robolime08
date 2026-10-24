import { startPolling, type Timers } from './statusPoller';

/** Manual timers: tests decide exactly when each scheduled poll fires. */
function manualTimers() {
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const timers: Timers = {
    setTimeout: (cb, ms) => {
      const id = next++;
      pending.set(id, { cb, ms });
      return id;
    },
    clearTimeout: (id) => void pending.delete(id as number),
  };
  const fire = () => {
    const [id, t] = [...pending.entries()][0] ?? [];
    if (id === undefined || t === undefined) throw new Error('no timer pending');
    pending.delete(id);
    t.cb();
  };
  return { timers, pending, fire };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setImmediate(() => r()));

describe('startPolling', () => {
  it('never overlaps: the next request is scheduled only after the previous one finishes', async () => {
    const { timers, pending, fire } = manualTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: ReturnType<typeof deferred<number>>[] = [];
    const stop = startPolling({
      request: () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const d = deferred<number>();
        gates.push(d);
        return d.promise.finally(() => inFlight--);
      },
      onResult: () => true,
      intervalMs: 10_000,
      timers,
    });
    expect(gates).toHaveLength(1);
    expect(pending.size).toBe(0); // nothing scheduled while the first request is in flight
    gates[0]?.resolve(1);
    await flush();
    expect(pending.size).toBe(1);
    expect([...pending.values()][0]?.ms).toBe(10_000);
    fire();
    expect(gates).toHaveLength(2);
    expect(pending.size).toBe(0);
    gates[1]?.resolve(2);
    await flush();
    expect(maxInFlight).toBe(1);
    stop();
  });

  it('stop() cancels the scheduled poll and drops a result still in flight', async () => {
    const { timers, pending } = manualTimers();
    const d = deferred<string>();
    const results: string[] = [];
    const stop = startPolling({ request: () => d.promise, onResult: (r) => void results.push(r), intervalMs: 10, timers });
    stop();
    d.resolve('late');
    await flush();
    expect(results).toEqual([]);
    expect(pending.size).toBe(0);
  });

  it('stops when onResult returns false (session invalid)', async () => {
    const { timers, pending } = manualTimers();
    let calls = 0;
    startPolling({ request: async () => ++calls, onResult: () => false, intervalMs: 10, timers });
    await flush();
    expect(calls).toBe(1);
    expect(pending.size).toBe(0);
  });

  it('keeps polling after a request that throws', async () => {
    const { timers, pending } = manualTimers();
    const stop = startPolling({
      request: async () => {
        throw new Error('boom');
      },
      onResult: () => true,
      intervalMs: 10,
      timers,
    });
    await flush();
    expect(pending.size).toBe(1);
    stop();
    expect(pending.size).toBe(0);
  });
});
