/* Manifest Defer */

(function () {


// Directives that render their own children — never stash under them
const OWNS_CHILDREN = new Set([
    'x-html', 'x-text', 'x-ignore', 'x-markdown', 'x-icon', 'x-svg', 'x-code', 'x-code-group',
    'x-chart', 'x-carousel', 'x-virtual', 'x-combobox', 'x-colorpicker', 'x-date', 'x-text-edit'
]);

// Kill switch: data-defer="off" on the loader script; prerender snapshots keep eager markup
const killed = !!document.querySelector('script[data-defer="off"]') || window.__manifestRender === true;

const pending = new Set();
let ready = false;
let bootDrained = false;
let idleHandle = null;

// Urgent = mounted after boot, within a gesture window (a pane the user just opened), capped per gesture
const URGENT_WINDOW_MS = 1500;
const URGENT_CAP = 8;
const PREWARM_CAP = 48;          // non-urgent renders per page — beyond this, containers render on open
const IDLE_BUDGET_MS = 4;
const SLICE_MAX = 8;
let prewarmed = 0;
let lastGestureAt = -Infinity;
let urgentWindowAt = -Infinity;
let urgentInWindow = 0;
const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

function isUrgent() {
    if (!ready || !bootDrained || now() - lastGestureAt > URGENT_WINDOW_MS) return false;
    if (urgentWindowAt !== lastGestureAt) { urgentWindowAt = lastGestureAt; urgentInWindow = 0; }
    return urgentInWindow++ < URGENT_CAP;
}

// ---- Detection ----

const isPopoverOpen = (el) => { try { return el.matches(':popover-open'); } catch (_) { return false; } };

// x-defer modifiers + whether a child-owning directive sits on the element
function readAttrs(el) {
    const attrs = el.attributes;
    let opts = null, owns = false;
    for (let i = 0; i < attrs.length; i++) {
        const name = attrs[i].name;
        if (name.charCodeAt(0) !== 120) continue;
        if (name === 'x-defer' || name.startsWith('x-defer.')) {
            const mods = name.split('.').slice(1);
            opts = {
                lazy: mods.includes('lazy'),
                discard: mods.includes('discard'),
                off: mods.includes('off'),
                priority: mods.includes('priority') ? (parseInt(attrs[i].value, 10) || 0) : 0
            };
        } else if (OWNS_CHILDREN.has(name)) {
            owns = true;
        }
    }
    return { opts, owns };
}

// First panel of a tab set is the initially selected one (tabs.js default)
function firstPanel(el) {
    const set = (el.getAttribute('x-tabpanel') || '').replace(/["\\]/g, '\\$&');
    const root = el.getRootNode();
    const scope = root && typeof root.querySelector === 'function' ? root : document;
    return scope.querySelector(`[x-tabpanel="${set}"]`);
}

// Closed-container rule, or the visibility rule for explicit x-defer
function ruleFor(el, explicit) {
    if (el.hasAttribute('popover')) return isPopoverOpen(el) ? null : 'popover';
    const tag = el.tagName;
    if (tag === 'DIALOG' || tag === 'DETAILS') return el.hasAttribute('open') ? null : 'toggle';
    if (el.hasAttribute('hidden') && !el.hasAttribute('x-route')) return 'hidden';
    if (el.hasAttribute('x-tabpanel') && window.ensureTabsPluginInitialized) return firstPanel(el) === el ? null : 'panel';
    return explicit ? 'visible' : null;
}

function shown(el, computed) {
    if (el.hidden || el.style.display === 'none') return false;
    if (computed && el.isConnected) { try { return getComputedStyle(el).display !== 'none'; } catch (_) { } }
    return true;
}

// ---- Stash / render ----

function register(el, rule, opts) {
    const existing = el.firstElementChild;
    let tpl;
    // Adopt a stash serialized by an earlier session (single marked template child)
    if (existing && existing.tagName === 'TEMPLATE' && existing.hasAttribute('data-mnfst-defer') && el.children.length === 1) {
        tpl = existing;
    } else {
        tpl = document.createElement('template');
        tpl.setAttribute('data-mnfst-defer', '');
        Alpine.mutateDom(() => {
            while (el.firstChild) tpl.content.appendChild(el.firstChild);
            el.appendChild(tpl);
        });
    }
    const rec = el.__mnfstDefer = {
        el, tpl, rule,
        lazy: !!(opts && opts.lazy),
        discard: !!(opts && opts.discard),
        priority: opts ? opts.priority : 0,
        urgent: isUrgent(),
        rendered: false,
        cleanup: []
    };
    wire(rec);
    if (!rec.lazy) { pending.add(rec); schedule(); }
    return rec;
}

function render(rec) {
    if (rec.rendered) return;
    rec.rendered = true;
    pending.delete(rec);
    const { el, tpl } = rec;
    const content = rec.discard ? tpl.content.cloneNode(true) : tpl.content;
    Alpine.mutateDom(() => {
        tpl.remove();
        el.appendChild(content);
    });
    Array.from(el.children).forEach((child) => Alpine.initTree(child));
    el.dispatchEvent(new CustomEvent('manifest:defer-render'));
}

function teardown(rec) {
    if (!rec.rendered) return;
    rec.rendered = false;
    const { el, tpl } = rec;
    Alpine.mutateDom(() => {
        Array.from(el.children).forEach((child) => Alpine.destroyTree(child));
        while (el.firstChild) el.firstChild.remove();
        el.appendChild(tpl);
    });
}

// ---- Open signals ----

function wire(rec) {
    const { el, rule } = rec;
    const onState = (open) => { if (open) render(rec); else if (rec.discard) teardown(rec); };
    const listen = (type, fn) => {
        el.addEventListener(type, fn);
        rec.cleanup.push(() => el.removeEventListener(type, fn));
    };
    const observe = (attrs, fn) => {
        const mo = new MutationObserver(fn);
        mo.observe(el, { attributes: true, attributeFilter: attrs });
        rec.cleanup.push(() => mo.disconnect());
    };

    if (rule === 'popover') {
        // Render before the popover paints so positioning sees real content
        listen('beforetoggle', (e) => { if (e.newState === 'open') render(rec); });
        if (rec.discard) listen('toggle', (e) => { if (e.newState === 'closed') teardown(rec); });
    } else if (rule === 'toggle') {
        listen('beforetoggle', (e) => { if (e.newState === 'open') render(rec); });
        listen('toggle', () => onState(el.hasAttribute('open')));
        observe(['open'], () => onState(el.hasAttribute('open')));
    } else if (rule === 'hidden') {
        const arm = () => Alpine.onAttributeRemoved(el, 'hidden', () => {
            if (el.hasAttribute('hidden')) { arm(); return; }
            render(rec);
            if (rec.discard) arm();
        });
        arm();
        if (rec.discard) observe(['hidden'], () => { if (el.hasAttribute('hidden')) teardown(rec); });
    } else if (rule === 'panel') {
        observe(['style', 'x-show', 'x-tabpanel'], () => onState(shown(el, false)));
    } else if (rule === 'visible') {
        observe(['style', 'hidden', 'class'], () => onState(shown(el, true)));
        queueMicrotask(() => { if (!rec.rendered && shown(el, true)) render(rec); });
    }
}

// ---- Idle prewarm (after manifest:ready; urgent first, then priority asc, then document order) ----

const idle = (fn, timeout) => window.requestIdleCallback
    ? window.requestIdleCallback(fn, { timeout })
    : setTimeout(() => fn({ didTimeout: true, timeRemaining: () => 0 }), 50);

// Only containers the user can reach: not under a hidden route; visible parents first
const reachable = (el) => !el.closest('[x-route][hidden]');
function nearViewport(el) {
    const p = el.parentElement;
    if (!p) return false;
    const r = p.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}
function rank(rec) {
    if (rec.near === undefined) rec.near = nearViewport(rec.el);
    return (rec.urgent ? 0 : 4) + (rec.near ? 0 : 2);
}
function next() {
    let best = null, bestRank = 0;
    for (const rec of pending) {
        if (!rec.el.isConnected) { pending.delete(rec); continue; }
        if (!reachable(rec.el) || (!rec.urgent && prewarmed >= PREWARM_CAP)) continue;
        const r = rank(rec);
        if (!best
            || r < bestRank
            || (r === bestRank && (rec.priority < best.priority
                || (rec.priority === best.priority && (best.el.compareDocumentPosition(rec.el) & Node.DOCUMENT_POSITION_PRECEDING))))) {
            best = rec; bestRank = r;
        }
    }
    return best;
}

function schedule() {
    if (pending.size === 0) { if (ready) bootDrained = true; return; }
    if (idleHandle !== null || !ready) return;
    const head = next();
    if (!head) { if (ready) bootDrained = true; return; }
    idleHandle = idle((deadline) => {
        idleHandle = null;
        // Forced fire (never-idle page): one container. Genuine idle: batch within the budget.
        let n = 0;
        do {
            const rec = next();
            if (!rec) break;
            for (const other of pending) other.near = undefined;
            render(rec);
            if (!rec.urgent) prewarmed++;
            n++;
        } while (deadline && !deadline.didTimeout && deadline.timeRemaining() > IDLE_BUDGET_MS && n < SLICE_MAX);
        schedule();
    }, head.urgent ? 100 : 500);
}

function markReady() {
    if (ready) return;
    ready = true;
    schedule();
    setTimeout(() => { bootDrained = true; }, 5000); // lazy components may keep the boot queue busy
}

function armReady() {
    if (window.__manifestReady) { markReady(); return; }
    window.addEventListener('manifest:ready', markReady, { once: true });
    // No loader → no coordinator; settle on window load instead
    if (!window.__manifestLoaderStarted) {
        if (document.readyState === 'complete') setTimeout(markReady, 0);
        else window.addEventListener('load', markReady, { once: true });
    }
}

// ---- Interceptor + cooperative API ----

function defer(el) {
    if (killed || !window.Alpine || !el || el.nodeType !== 1) return null;
    if (el.__mnfstDefer) return el.__mnfstDefer;
    const { opts, owns } = readAttrs(el);
    if (owns || (opts && opts.off)) return null;
    const rule = ruleFor(el, !!opts);
    if (!rule || !el.firstElementChild) return null;
    return register(el, rule, opts);
}

function intercept(el, skip) {
    if (el.__mnfstDefer) return;
    if (defer(el)) skip();
}

function initializeDeferPlugin() {
    Alpine.directive('defer', () => { });
    if (!killed) Alpine.interceptInit(Alpine.skipDuringClone(intercept));
    ['pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, () => { lastGestureAt = now(); }, { capture: true, passive: true }));
    armReady();
}

window.ManifestDefer = {
    enabled: !killed,
    defer,
    render: (el) => { if (el && el.__mnfstDefer) render(el.__mnfstDefer); },
    isPending: (el) => !!(el && el.__mnfstDefer && !el.__mnfstDefer.rendered)
};
if (window.Manifest && typeof window.Manifest === 'object') window.Manifest.defer = defer;

// ---- Plugin init boilerplate ----

let deferPluginInitialized = false;

function ensureDeferPluginInitialized() {
    if (deferPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.interceptInit !== 'function') return;
    deferPluginInitialized = true;
    initializeDeferPlugin();
}

window.ensureDeferPluginInitialized = ensureDeferPluginInitialized;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureDeferPluginInitialized);
}
document.addEventListener('alpine:init', ensureDeferPluginInitialized);

if (window.Alpine && typeof window.Alpine.interceptInit === 'function') {
    ensureDeferPluginInitialized();
} else {
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.interceptInit === 'function') {
            clearInterval(checkAlpine);
            ensureDeferPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}

})();
