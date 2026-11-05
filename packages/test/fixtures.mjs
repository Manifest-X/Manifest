// Deterministic tenant fixtures for createFakeAppwrite / the browser runner.

const WORDS = ['alpha', 'bravo', 'cobalt', 'delta', 'ember', 'falcon', 'garnet', 'harbor', 'indigo', 'juniper',
    'kestrel', 'lumen', 'meadow', 'nimbus', 'orchid', 'pioneer', 'quartz', 'raven', 'sierra', 'tundra'];

// Seeded PRNG (mulberry32)
export function seededRandom(seed = 1) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// count rows from build(i, helpers); stable ids and one-minute-apart timestamps
export function makeRows(count, build = () => ({}), { seed = 1, prefix = 'row', start = '2026-01-01T00:00:00.000Z', step = 60000 } = {}) {
    const rand = seededRandom(seed);
    const t0 = Date.parse(start);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const helpers = { rand, pick, words: (n = 2) => Array.from({ length: n }, () => pick(WORDS)).join(' '), int: (min, max) => min + Math.floor(rand() * (max - min + 1)) };
    const rows = [];
    for (let i = 0; i < count; i++) {
        const at = new Date(t0 + i * step).toISOString().replace('Z', '+00:00');
        rows.push({ $id: `${prefix}${String(i + 1).padStart(6, '0')}`, $createdAt: at, $updatedAt: at, ...build(i, helpers) });
    }
    return rows;
}

// schema: { [databaseId]: { [tableId]: build | { build, count } } }
export function heavyTenant(schema, { rows = 5000, seed = 1, ...rest } = {}) {
    return tenant(schema, (spec) => spec.count ?? rows, seed, rest);
}

export function emptyTenant(schema, rest = {}) {
    return tenant(schema, () => 0, 1, rest);
}

function tenant(schema, countOf, seed, rest) {
    const databases = {};
    let n = 0;
    for (const [databaseId, tables] of Object.entries(schema)) {
        databases[databaseId] = {};
        for (const [tableId, spec] of Object.entries(tables)) {
            const s = typeof spec === 'function' ? { build: spec } : spec;
            databases[databaseId][tableId] = makeRows(countOf(s), s.build, { seed: seed + n++, prefix: s.prefix || `${tableId.slice(0, 3)}` });
        }
    }
    return { ...rest, databases };
}
