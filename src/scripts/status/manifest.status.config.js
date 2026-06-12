/*  Manifest Status — config
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Reads the top-level `status` block from manifest.json and normalizes each
/*  named entry into { signals[], rollup, refresh, ... }. Pure signal layer —
/*  no UI. Each entry resolves to $status.<name> (see manifest.status.main.js).
*/

(function () {
    'use strict';

    // Infer a signal's provider type from which field is present (mirrors the
    // data plugin's field-presence inference).
    function normalizeSignal(sig) {
        if (typeof sig === 'string') return { type: 'probe', url: sig, label: sig };
        if (!sig || typeof sig !== 'object') return { type: 'unknown', label: 'unknown' };

        if (sig.static) return { type: 'static', state: sig.static, label: sig.label || 'static' };
        if (sig.feed) return { type: 'feed', url: sig.feed, path: sig.path, label: sig.label || sig.feed };
        if (sig.mirror) return { type: 'mirror', mirror: sig.mirror, label: sig.label || sig.mirror };
        if (sig.appwriteService || sig.appwriteTableId)
            return { type: 'appwrite', service: sig.appwriteService || 'health', label: sig.label || 'appwrite' };
        if (sig.mcp) return { type: 'mcp', mcp: sig.mcp, label: sig.label || 'mcp' };
        if (sig.heartbeat)
            return { type: 'heartbeat', heartbeat: sig.heartbeat, expectEvery: sig.expectEvery || 60000, label: sig.label || sig.heartbeat };
        if (sig.url)
            return {
                type: 'probe', url: sig.url, label: sig.label || sig.url,
                expect: sig.expect, degradedAbove: sig.degradedAbove,
                method: sig.method || 'GET', headers: sig.headers, timeout: sig.timeout
            };
        return { type: 'unknown', label: sig.label || 'unknown' };
    }

    // Normalize a manifest.status entry (string | array | object) into a record.
    function normalizeEntry(name, def) {
        const opts = { rollup: 'worst', refresh: 30000, confirmations: 1, staleAfter: null, history: 90 };
        let signals = [];

        if (typeof def === 'string') {
            signals = [normalizeSignal(def)];
        } else if (Array.isArray(def)) {
            signals = def.map(normalizeSignal);
        } else if (def && typeof def === 'object') {
            if (Array.isArray(def.signals)) {
                signals = def.signals.map(normalizeSignal);
                if (def.rollup) opts.rollup = def.rollup;
                if (def.refresh) opts.refresh = def.refresh;
                if (def.confirmations) opts.confirmations = def.confirmations;
                if (def.staleAfter) opts.staleAfter = def.staleAfter;
            } else {
                // Single-signal object (carries its own provider field).
                signals = [normalizeSignal(def)];
                if (def.refresh) opts.refresh = def.refresh;
            }
        }

        if (def && typeof def === 'object' && !Array.isArray(def) && def.history) opts.history = def.history;
        if (opts.staleAfter == null) opts.staleAfter = opts.refresh * 3;
        return { name, signals, ...opts };
    }

    // Resolve manifest.json. Reuse a cached copy only if it actually carries the
    // `status` block — other plugins may cache a normalized manifest that omits
    // keys they don't consume, so fall through to a fresh fetch otherwise.
    async function ensureStatusManifest() {
        const cached = window.ManifestComponentsRegistry?.manifest || window.__manifestLoaded;
        if (cached && cached.status) return cached;
        try {
            const url = document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '/manifest.json';
            const res = await fetch(url);
            return await res.json();
        } catch (_) {
            return cached || null;
        }
    }

    async function getStatusConfig() {
        const manifest = await ensureStatusManifest();
        if (!manifest?.status || typeof manifest.status !== 'object') return null;
        const entries = {};
        for (const [name, def] of Object.entries(manifest.status)) {
            entries[name] = normalizeEntry(name, def);
        }
        return { entries, appwriteEndpoint: manifest.appwrite?.endpoint || null };
    }

    window.ManifestStatusConfig = { getStatusConfig, normalizeEntry, normalizeSignal, ensureStatusManifest };
})();
