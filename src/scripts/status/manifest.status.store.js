/*  Manifest Status — store
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Internal reactive store backing $status. Mirrors store('data'):
/*  named entries + a _version counter bumped on every update.
*/

(function () {
    'use strict';

    // Ordered severity. maintenance sits between operational and degraded so a
    // worst-of rollup surfaces it over a fully-operational set. unknown = -1.
    const LEVELS = {
        operational: 0,
        maintenance: 0.5,
        degraded: 1,
        partial_outage: 2,
        major_outage: 3,
        unknown: -1
    };

    function level(state) {
        return Object.prototype.hasOwnProperty.call(LEVELS, state) ? LEVELS[state] : -1;
    }

    // Placeholder health for an unknown/not-yet-resolved entry.
    function emptyHealth(name) {
        return { name, state: 'unknown', level: -1, up: false, latencyMs: null, message: null, uptime: null, history: [], incidents: [], updatedAt: null, stale: false, signals: [] };
    }

    function initializeStore() {
        if (!window.Alpine) return;
        if (window.Alpine.store('status')) return;
        window.Alpine.store('status', { _version: 0, _ready: false, entries: {}, incidents: [] });
    }

    window.ManifestStatusStore = { LEVELS, level, emptyHealth, initializeStore };
})();
