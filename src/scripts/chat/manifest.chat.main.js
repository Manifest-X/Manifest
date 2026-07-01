/*  Manifest Chat — magic + init
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Registers $chat. Renders nothing — the author drives their UI off the handle.
/*    open(conversationId, { adapter, around?, aggregate? }) · merge(handles, { order })
/*    adapter(name, factory) · flatten(tree)
*/

(function () {
    'use strict';

    function api() {
        const Store = window.ManifestChatStore;
        const Adapters = window.ManifestChatAdapters;
        return {
            open(conversationId, opts) {
                opts = opts || {};
                const adapter = Adapters.resolve(opts.adapter, opts);
                const aggregate = opts.aggregate || (typeof opts.adapter === 'string' && /aggregate/.test(opts.adapter));
                return Store.createHandle(adapter, conversationId, Object.assign({}, opts, { aggregate }));
            },
            merge(handles, o) { return Store.mergeHandles(handles, o); },
            adapter(name, factory) { if (factory === undefined) return Adapters.resolve(name); Adapters.register(name, factory); },
            flatten(tree) { return Store.flattenTree(tree); },
            get sim() { return Adapters.sim; }      // demo/sim hooks; harmless in prod (no callers)
        };
    }

    function registerMagic() {
        if (!window.Alpine || typeof window.Alpine.magic !== 'function') return false;
        if (registerMagic._done) return true;
        // Bind the api once; $chat.* are stable references (handles carry their own reactivity).
        const instance = api();
        window.Alpine.magic('chat', () => instance);
        registerMagic._done = true;
        return true;
    }

    function ensureInitialized() {
        if (!window.ManifestChatStore || !window.ManifestChatAdapters) return;
        registerMagic();
    }

    window.ensureManifestChatInitialized = ensureInitialized;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureInitialized);
    document.addEventListener('alpine:init', ensureInitialized);

    if (window.Alpine && typeof window.Alpine.magic === 'function') {
        setTimeout(ensureInitialized, 0);
    } else {
        const check = setInterval(() => {
            if (window.Alpine && typeof window.Alpine.magic === 'function') { clearInterval(check); ensureInitialized(); }
        }, 10);
        setTimeout(() => clearInterval(check), 5000);
    }
})();
