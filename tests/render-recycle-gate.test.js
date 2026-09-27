import { describe, it, expect } from 'vitest';
import { createRecycleGate, runRenderQueue, isTransientFrameError } from '../src/scripts/manifest.render.mjs';

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

// Defect (Manifest-Website, 84/86 failed): a timed-out page forced a recycle,
// the swap detached sibling pages, their retries forced more recycles — a
// storm. Fake browser: a swap under a live page detaches it.
describe('runRenderQueue — forced-recycle storm', () => {
    function fakeBrowser() {
        const b = { generation: 0, live: new Set(), detachedUnderSwap: 0 };
        b.swap = async () => {
            for (const page of b.live) { page.detached = true; b.detachedUnderSwap++; }
            b.live.clear();
            await tick(2);
            b.generation++;
        };
        b.render = async ({ ms = 3, hang = false, token } = {}) => {
            const page = { detached: false, closed: false, generation: b.generation };
            b.live.add(page);
            let close;
            const closed = new Promise((resolve) => { close = resolve; });
            page.close = () => { page.closed = true; b.live.delete(page); close(); };
            if (token) token.cancel = page.close;
            try {
                if (hang) await closed;
                else await tick(ms);
                if (page.detached) throw new Error('Execution context is not available in detached frame');
            } finally {
                page.close();
            }
            return page;
        };
        return b;
    }

    it('a page that times out mid-run forces one bounded recycle, siblings succeed', async () => {
        const browser = fakeBrowser();
        const logs = [];
        const gate = createRecycleGate({ every: 40, recycle: browser.swap, onLog: (m) => logs.push(m) });
        const hangs = new Map([[10, 1], [55, 1]]);
        const done = [];
        const items = Array.from({ length: 86 }, (_, i) => i);
        const failures = await runRenderQueue({
            items,
            concurrency: 4,
            gate,
            pageTimeoutMs: 40,
            maxRetries: 2,
            abandonGraceMs: 50,
            render: async (i, _idx, token) => {
                const hang = (hangs.get(i) || 0) > 0;
                if (hang) hangs.set(i, hangs.get(i) - 1);
                const page = await browser.render({ ms: i % 4, hang, token });
                if (token.abandoned) return;
                done.push(i);
                return page;
            },
        });
        expect(failures).toEqual([]);
        expect(new Set(done).size).toBe(86);
        expect(browser.detachedUnderSwap).toBe(0);
        expect(gate.recycles).toBeLessThanOrEqual(4);
        expect(gate.forcedRecycles).toBeLessThanOrEqual(2);
        expect(logs).toEqual([]);
    });

    it('a page that always wedges cannot drive a recycle loop', async () => {
        const browser = fakeBrowser();
        const gate = createRecycleGate({ every: 40, recycle: browser.swap });
        const failures = await runRenderQueue({
            items: Array.from({ length: 30 }, (_, i) => i),
            concurrency: 3,
            gate,
            pageTimeoutMs: 30,
            maxRetries: 2,
            abandonGraceMs: 50,
            render: async (i, _idx, token) => browser.render({ hang: i === 3, token }),
        });
        expect(failures.map((f) => f.path)).toEqual(['3']);
        expect(browser.detachedUnderSwap).toBe(0);
        // 3 attempts, cooldown 10 completed paths between forced swaps
        expect(gate.forcedRecycles).toBeLessThanOrEqual(3);
    });

    it('coalesces forced requests per browser generation', async () => {
        let swaps = 0;
        const gate = createRecycleGate({ every: 40, forcedCooldown: 1, recycle: async () => { swaps++; } });
        const gen = await gate.acquire();
        gate.release();
        expect(gate.requestRecycle(gen)).toBe(true);
        expect(gate.requestRecycle(gen)).toBe(true);
        expect(await gate.maybeRecycle()).toBe(true);
        expect(swaps).toBe(1);
        // stale: that browser is already gone
        expect(gate.requestRecycle(gen)).toBe(false);
        expect(await gate.maybeRecycle()).toBe(false);
        expect(swaps).toBe(1);
    });

    it('counts completed paths only; a forced request does not inflate the count', async () => {
        const calls = [];
        const gate = createRecycleGate({ every: 1000, recycle: async (processed, opts) => { calls.push([processed, opts]); } });
        const flaky = new Set([3, 7]);
        const failures = await runRenderQueue({
            items: Array.from({ length: 10 }, (_, i) => i),
            concurrency: 3,
            gate,
            maxRetries: 2,
            render: async (i) => {
                await tick(1);
                if (flaky.delete(i)) throw new Error('Attempted to use detached Frame');
            },
        });
        expect(failures).toEqual([]);
        expect(gate.pages).toBe(10);
        gate.requestRecycle();
        expect(gate.pages).toBe(10);
        expect(await gate.maybeRecycle()).toBe(true);
        expect(calls).toEqual([[10, { forced: true }]]);
    });

    it('rate-limits forced recycles by completed paths', async () => {
        let swaps = 0;
        const gate = createRecycleGate({ every: 40, forcedCooldown: 3, recycle: async () => { swaps++; } });
        gate.requestRecycle();
        expect(await gate.maybeRecycle()).toBe(true);
        gate.requestRecycle();
        expect(await gate.maybeRecycle()).toBe(false);
        gate.countPage(); gate.countPage();
        expect(await gate.maybeRecycle()).toBe(false);
        gate.countPage();
        expect(await gate.maybeRecycle()).toBe(true);
        expect(swaps).toBe(2);
        expect(gate.forcedRecycles).toBe(2);
    });
});
