/*  Manifest Status — signal resolvers + rollup
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Each provider type resolves a normalized signal to { state, latencyMs }.
/*  Generic providers (probe/feed/static/heartbeat) are fully implemented;
/*  appwrite resolves via the public /health endpoint; mirror uses a small
/*  registry of known upstream feeds; mcp is feed-based and pluggable.
*/

(function () {
    'use strict';

    // Map an arbitrary upstream state string onto the Manifest vocabulary.
    function normalizeFeedState(raw) {
        if (!raw) return 'unknown';
        const s = String(raw).toLowerCase();
        if (['operational', 'up', 'pass', 'ok', 'none', 'healthy', 'available'].includes(s)) return 'operational';
        if (['degraded', 'minor', 'slow', 'degraded_performance'].includes(s)) return 'degraded';
        if (['partial', 'partial_outage'].includes(s)) return 'partial_outage';
        if (['major', 'major_outage', 'down', 'critical', 'fail', 'outage', 'unavailable'].includes(s)) return 'major_outage';
        if (['maintenance', 'maintenance_in_progress', 'under_maintenance'].includes(s)) return 'maintenance';
        return 'unknown';
    }

    function dig(obj, path) {
        if (!path) return obj;
        return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    }

    async function probe(sig) {
        const timeout = sig.timeout || 8000;
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeout);
        const start = (window.performance && performance.now) ? performance.now() : Date.now();
        try {
            const res = await fetch(sig.url, {
                method: sig.method || 'GET',
                headers: sig.headers || undefined,
                signal: controller.signal,
                cache: 'no-store'
            });
            clearTimeout(t);
            const latencyMs = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - start);
            const ok = sig.expect ? res.status === sig.expect : res.ok;
            let state;
            if (ok) state = (sig.degradedAbove && latencyMs > sig.degradedAbove) ? 'degraded' : 'operational';
            else if (res.status >= 500) state = 'major_outage';
            else state = 'partial_outage';
            return { state, latencyMs };
        } catch (err) {
            clearTimeout(t);
            // Network error / CORS / timeout: can't distinguish down from blocked,
            // so report unknown rather than a false outage.
            return { state: 'unknown', latencyMs: null, error: err && err.name ? err.name : 'fetch failed' };
        }
    }

    async function feed(sig) {
        try {
            const res = await fetch(sig.url, { cache: 'no-store' });
            if (!res.ok) return { state: 'unknown', latencyMs: null, error: 'feed ' + res.status };
            const json = await res.json();
            // The feed node may be a bare state string, or an object carrying
            // both a state and a human update message.
            const node = sig.path ? dig(json, sig.path) : json;
            const obj = (node && typeof node === 'object') ? node : null;
            const raw = obj ? (obj.state != null ? obj.state : obj.status) : node;
            const message = (obj && obj.message) ? obj.message : (json.message || null);
            // Optional historical data a backend can hydrate.
            const history = Array.isArray(obj && obj.history) ? obj.history : (Array.isArray(json.history) ? json.history : undefined);
            const uptime = (obj && typeof obj.uptime === 'number') ? obj.uptime : (typeof json.uptime === 'number' ? json.uptime : undefined);
            const incidents = Array.isArray(obj && obj.incidents) ? obj.incidents : (Array.isArray(json.incidents) ? json.incidents : undefined);
            return { state: normalizeFeedState(raw), latencyMs: null, message, history, uptime, incidents };
        } catch (_) {
            return { state: 'unknown', latencyMs: null, error: 'feed failed' };
        }
    }

    // Atlassian Statuspage v2 indicator → Manifest vocabulary. Most hosted
    // status pages (and their /api/v2/status.json) follow this shape and serve
    // permissive CORS, so they resolve client-side.
    function mapStatuspageIndicator(ind) {
        switch (String(ind || '').toLowerCase()) {
            case 'none': return 'operational';
            case 'minor': return 'degraded';
            case 'major': return 'partial_outage';
            case 'critical': return 'major_outage';
            case 'maintenance': return 'maintenance';
            default: return 'unknown';
        }
    }

    async function fetchStatuspage(base) {
        const res = await fetch(base.replace(/\/$/, '') + '/api/v2/status.json', { cache: 'no-store' });
        if (!res.ok) return { state: 'unknown', latencyMs: null, error: 'mirror ' + res.status };
        const json = await res.json();
        return { state: mapStatuspageIndicator(json && json.status && json.status.indicator), latencyMs: null };
    }

    // Known upstream status feeds. Extend this registry, or pass a Statuspage
    // base URL directly as the mirror value.
    const MIRRORS = {
        appwrite: { url: 'https://cloud.appwrite.io/v1/health', path: 'status', map: v => (v === 'pass' ? 'operational' : 'degraded') },
        github: { statuspage: 'https://www.githubstatus.com' },
        cloudflare: { statuspage: 'https://www.cloudflarestatus.com' },
        stripe: { statuspage: 'https://status.stripe.com' },
        openai: { statuspage: 'https://status.openai.com' },
        anthropic: { statuspage: 'https://status.anthropic.com' },
        discord: { statuspage: 'https://discordstatus.com' },
        npm: { statuspage: 'https://status.npmjs.org' },
        vercel: { statuspage: 'https://www.vercel-status.com' },
        netlify: { statuspage: 'https://www.netlifystatus.com' }
    };

    async function mirror(sig) {
        // A bare URL is treated as a Statuspage base, so any provider works
        // without a registry entry.
        if (/^https?:\/\//.test(sig.mirror)) {
            try { return await fetchStatuspage(sig.mirror); }
            catch (_) { return { state: 'unknown', latencyMs: null, error: 'mirror failed' }; }
        }
        const m = MIRRORS[sig.mirror];
        if (!m) return { state: 'unknown', latencyMs: null, error: 'unknown mirror: ' + sig.mirror };
        try {
            if (m.statuspage) return await fetchStatuspage(m.statuspage);
            const res = await fetch(m.url, { cache: 'no-store' });
            if (!res.ok) return { state: 'unknown', latencyMs: null, error: 'mirror ' + res.status };
            const json = await res.json();
            const raw = m.path ? dig(json, m.path) : json;
            return { state: m.map ? m.map(raw) : normalizeFeedState(raw), latencyMs: null };
        } catch (_) {
            return { state: 'unknown', latencyMs: null, error: 'mirror failed' };
        }
    }

    // Heartbeats: external systems call $status.beat(key); absence past the
    // window reads as a major outage (dead-man's switch).
    const heartbeats = {};
    function recordHeartbeat(key) { heartbeats[key] = Date.now(); }
    function resolveHeartbeat(sig) {
        const last = heartbeats[sig.heartbeat];
        if (!last) return { state: 'unknown', latencyMs: null, error: 'no heartbeat yet' };
        const overdue = (Date.now() - last) > (sig.expectEvery || 60000);
        return { state: overdue ? 'major_outage' : 'operational', latencyMs: null };
    }

    async function resolveSignal(sig, ctx) {
        switch (sig.type) {
            case 'static': return { state: sig.state || 'unknown', latencyMs: null };
            case 'probe': return await probe(sig);
            case 'feed': return await feed(sig);
            case 'mirror': return await mirror(sig);
            case 'heartbeat': return resolveHeartbeat(sig);
            case 'appwrite': {
                const base = ctx && ctx.appwriteEndpoint;
                if (!base) return { state: 'unknown', latencyMs: null, error: 'no appwrite endpoint' };
                return await probe({ ...sig, url: base.replace(/\/$/, '') + '/health' });
            }
            case 'mcp':
                if (typeof sig.mcp === 'string' && /^https?:\/\//.test(sig.mcp)) return await feed({ ...sig, url: sig.mcp });
                return { state: 'unknown', latencyMs: null, error: 'mcp provider not configured' };
            default:
                return { state: 'unknown', latencyMs: null };
        }
    }

    // Fold resolved child signals into one entry health.
    function rollup(entry, resolved) {
        const level = window.ManifestStatusStore.level;
        const known = resolved.filter(r => r.state && r.state !== 'unknown');

        let winner = null;
        if (known.length) {
            winner = entry.rollup === 'best'
                ? known.reduce((a, b) => (level(b.state) < level(a.state) ? b : a))
                : known.reduce((a, b) => (level(b.state) > level(a.state) ? b : a));
        }
        const state = winner ? winner.state : 'unknown';
        const message = winner ? (winner.message || null) : null;

        const latencies = resolved.map(r => r.latencyMs).filter(n => typeof n === 'number');
        const latencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
        return { state, level: level(state), up: state === 'operational', latencyMs, message, history: winner ? winner.history : undefined, uptime: winner ? winner.uptime : undefined };
    }

    window.ManifestStatusSignals = { resolveSignal, rollup, recordHeartbeat, normalizeFeedState, MIRRORS };
})();
