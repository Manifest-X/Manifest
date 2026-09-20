import { describe, it, expect } from 'vitest';
import { createRecycleGate, isTransientFrameError } from '../src/scripts/manifest.render.mjs';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake render workers sharing one fake browser through the gate. */
function runWorkers({ gate, count, pages, onPage }) {
    let next = 0;
    const worker = async () => {
        while (true) {
            const i = next++;
            if (i >= pages) return;
            await gate.acquire();
            try {
                await onPage(i);
            } finally {
                gate.release();
            }
            gate.countPage();
            await gate.maybeRecycle();
        }
    };
    return Promise.all(Array.from({ length: count }, () => worker()));
}

describe('createRecycleGate', () => {
    it('drives 3 workers over 100 pages, recycling without stalling', async () => {
        let generation = 0;
        let recycles = 0;
        let activeDuringRecycle = 0;
        let swapping = false;
        const logs = [];
        const rendered = [];

        const gate = createRecycleGate({
            every: 40,
            onLog: (message) => logs.push(message),
            recycle: async () => {
                recycles++;
                swapping = true;
                activeDuringRecycle = Math.max(activeDuringRecycle, gate.active);
                await tick(2);
                activeDuringRecycle = Math.max(activeDuringRecycle, gate.active);
                generation++;
                swapping = false;
            },
        });

        await runWorkers({
            gate,
            count: 3,
            pages: 100,
            onPage: async (i) => {
                expect(swapping).toBe(false);
                await tick(i % 3);
                expect(swapping).toBe(false);
                rendered.push({ page: i, generation });
            },
        });

        expect(rendered).toHaveLength(100);
        expect(new Set(rendered.map((r) => r.page)).size).toBe(100);
        expect(recycles).toBe(2);
        expect(activeDuringRecycle).toBe(0);
        expect(gate.active).toBe(0);
        expect(gate.paused).toBe(false);
        expect(logs).toEqual([]);
    });

    // Defect (client-reported): the gate used to recycle "anyway" once
    // drainTimeoutMs elapsed, even with a page still live — racing a browser
    // swap against an in-flight page.evaluate() ("detached frame" / "Execution
    // context was destroyed"). Fix: the gate must WAIT for in-flight pages no
    // matter how long drainTimeoutMs is — the caller's own per-page timeout
    // (always configured to exceed drainTimeoutMs in production) guarantees
    // release() eventually fires, so waiting cannot deadlock.
    it('waits for an in-flight page past drainTimeoutMs instead of recycling under it', async () => {
        const logs = [];
        let released;
        const stuck = new Promise((resolve) => { released = resolve; });
        let recycles = 0;
        let activeDuringRecycle = 0;

        const gate = createRecycleGate({
            every: 10,
            drainTimeoutMs: 20,
            onLog: (message) => logs.push(message),
            recycle: async () => {
                recycles++;
                activeDuringRecycle = Math.max(activeDuringRecycle, gate.active);
            },
        });

        // One worker wedges on its page well past drainTimeoutMs, then finishes
        // on its own (simulating the outer pageTimeoutMs watchdog's guaranteed
        // release) — never via a recycle-triggered teardown.
        const wedged = (async () => {
            await gate.acquire();
            try { await stuck; } finally { gate.release(); }
        })();
        setTimeout(released, 80);

        let done = 0;
        await runWorkers({ gate, count: 2, pages: 40, onPage: async () => { done++; } });
        await wedged;

        expect(done).toBe(40);
        expect(recycles).toBeGreaterThanOrEqual(1);
        expect(activeDuringRecycle).toBe(0); // never swapped while the wedged page was live
        expect(logs.some((m) => m.includes('still in flight'))).toBe(true);
        expect(logs.some((m) => m.includes('recycling anyway'))).toBe(false);
    });

    it('keeps rendering when the browser swap fails', async () => {
        const logs = [];
        const gate = createRecycleGate({
            every: 5,
            onLog: (message) => logs.push(message),
            recycle: async () => { throw new Error('launch failed'); },
        });
        let done = 0;
        await runWorkers({ gate, count: 3, pages: 20, onPage: async () => { done++; } });
        expect(done).toBe(20);
        expect(logs.some((m) => m.includes('launch failed'))).toBe(true);
    });

    it('bounds a swap that never settles', async () => {
        const logs = [];
        const gate = createRecycleGate({
            every: 5,
            recycleTimeoutMs: 30,
            onLog: (message) => logs.push(message),
            recycle: () => new Promise(() => { }),
        });
        let done = 0;
        await runWorkers({ gate, count: 2, pages: 12, onPage: async () => { done++; } });
        expect(done).toBe(12);
        expect(logs.some((m) => m.includes('exceeded'))).toBe(true);
    });

    it('recycles on request and never with every: 0', async () => {
        let recycles = 0;
        const gate = createRecycleGate({ every: 40, recycle: async () => { recycles++; } });
        gate.countPage();
        expect(await gate.maybeRecycle()).toBe(false);
        gate.requestRecycle();
        expect(await gate.maybeRecycle()).toBe(true);
        expect(recycles).toBe(1);
        expect(gate.pages).toBe(0);

        const off = createRecycleGate({ every: 0, recycle: async () => { recycles++; } });
        off.requestRecycle();
        for (let i = 0; i < 100; i++) off.countPage();
        expect(await off.maybeRecycle()).toBe(false);
        expect(recycles).toBe(1);
    });
});

// Defect (client-reported): "detached frame" / "Execution context was
// destroyed" failures — caused by the browser-recycle race above — were
// retried with the same exponential backoff as any other failure, burning
// time on a race instead of just trying again. Fix: the render worker's
// retry loop (manifest.render.mjs, Phase 1) checks isTransientFrameError()
// and skips the backoff delay for a matching message.
describe('isTransientFrameError — immediate-requeue classification', () => {
    it('matches the known transient Puppeteer/browser-recycle race messages', () => {
        expect(isTransientFrameError('Attempted to use detached Frame \'ABCD\'.')).toBe(true);
        expect(isTransientFrameError('Execution context was destroyed')).toBe(true);
        expect(isTransientFrameError('Execution context is not available in detached frame')).toBe(true);
        expect(isTransientFrameError('Detached Frame during navigation')).toBe(true); // case-insensitive
    });
    it('does not match ordinary content/navigation failures', () => {
        expect(isTransientFrameError('net::ERR_CONNECTION_REFUSED')).toBe(false);
        expect(isTransientFrameError('page render exceeded 120000ms')).toBe(false);
        expect(isTransientFrameError('')).toBe(false);
        expect(isTransientFrameError(undefined)).toBe(false);
    });

    // Harness-level proof that a retry loop built the way manifest.render.mjs's
    // is (gate acquire/release + attempt backoff gated on the real predicate)
    // requeues a transient-frame failure with no delay, while an ordinary
    // failure still backs off.
    it('drives an immediate retry (no backoff) for a transient-frame failure, but backs off otherwise', async () => {
        const gate = createRecycleGate({ every: 0, recycle: async () => {} });
        async function attemptWithRetry(failures) {
            const timestamps = [];
            let attempt = 0;
            while (true) {
                timestamps.push(Date.now());
                await gate.acquire();
                const message = failures[attempt] ?? null;
                gate.release();
                if (!message) { gate.countPage(); return timestamps; }
                if (isTransientFrameError(message)) {
                    attempt++; // immediate requeue — no backoff sleep
                } else {
                    attempt++;
                    await new Promise((r) => setTimeout(r, 50 * attempt));
                }
            }
        }

        const transientTimestamps = await attemptWithRetry(['Execution context was destroyed', null]);
        expect(transientTimestamps[1] - transientTimestamps[0]).toBeLessThan(20);

        const ordinaryTimestamps = await attemptWithRetry(['net::ERR_CONNECTION_REFUSED', null]);
        expect(ordinaryTimestamps[1] - ordinaryTimestamps[0]).toBeGreaterThanOrEqual(45);
    });
});
