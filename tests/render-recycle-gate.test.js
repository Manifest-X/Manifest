import { describe, it, expect } from 'vitest';
import { createRecycleGate } from '../src/scripts/manifest.render.mjs';

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

    it('finishes even when a page never returns', async () => {
        const logs = [];
        let released;
        const stuck = new Promise((resolve) => { released = resolve; });
        let recycles = 0;

        const gate = createRecycleGate({
            every: 10,
            drainTimeoutMs: 40,
            onLog: (message) => logs.push(message),
            recycle: async () => { recycles++; },
        });

        // One worker wedges on its page (hung renderer) and never releases.
        const wedged = (async () => {
            await gate.acquire();
            try { await stuck; } finally { gate.release(); }
        })();

        let done = 0;
        await runWorkers({ gate, count: 2, pages: 40, onPage: async () => { done++; } });

        expect(done).toBe(40);
        expect(recycles).toBeGreaterThanOrEqual(1);
        expect(logs.some((m) => m.includes('still in flight'))).toBe(true);
        released();
        await wedged;
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
