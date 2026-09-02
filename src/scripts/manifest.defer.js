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
const PREWARM_CAP = (window.ManifestDeferConfig && window.ManifestDeferConfig.prewarmCap) || 48; // warm-but-unopened containers kept live
const IDLE_BUDGET_MS = 4;
const SLICE_MAX = 8;
const warm = new Set();          // prewarmed, never opened by the user
let lastGestureAt = -Infinity;
let urgentWindowAt = -Infinity;
let urgentInWindow = 0;
let promoteTimer = null;
let lastPromoteAt = -Infinity;
let gestureX = 0, gestureY = 0;
let idleIsTimer = false;
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

function render(rec, viaPrewarm) {
    if (rec.rendered) { if (!viaPrewarm && warm.delete(rec)) schedule(); return; }
    rec.rendered = true;
    pending.delete(rec);
    if (viaPrewarm) warm.add(rec); else warm.delete(rec);
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

// Evict a warm, still-closed, never-opened container back to its stash (least reachable first)
function restash(rec) {
    if (!rec.rendered) return;
    rec.rendered = false;
    rec.near = undefined;
    const { el, tpl } = rec;
    Alpine.mutateDom(() => {
        Array.from(el.children).forEach((child) => Alpine.destroyTree(child));
        while (el.firstChild) tpl.content.appendChild(el.firstChild);
        el.appendChild(tpl);
    });
    warm.delete(rec);
    pending.add(rec);
}

function evict() {
    if (warm.size <= PREWARM_CAP) return;
    for (const rec of warm) rec.near = undefined;
    while (warm.size > PREWARM_CAP) {
        let victim = null, score = -1;
        for (const rec of warm) {
            if (!rec.el.isConnected) { warm.delete(rec); continue; }
            if (rec.rule === 'popover' && isPopoverOpen(rec.el)) continue;
            if (rec.near === undefined) rec.near = nearViewport(rec);
            const sc = (reachable(rec.el) ? 0 : 2) + (rec.near ? 0 : 1);
            if (sc > score) { victim = rec; score = sc; }
        }
        if (!victim) return;
        restash(victim);
    }
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

// Genuine idle only: no timeout, so a never-idle page never prewarms (its stashed containers cost nothing)
const idle = (fn) => {
    idleIsTimer = !window.requestIdleCallback;
    return idleIsTimer
        ? setTimeout(() => fn({ didTimeout: false, timeRemaining: () => IDLE_BUDGET_MS + 1 }), 200)
        : window.requestIdleCallback(fn);
};
function cancelIdle() {
    if (idleHandle === null) return;
    if (idleIsTimer) clearTimeout(idleHandle); else if (window.cancelIdleCallback) window.cancelIdleCallback(idleHandle);
    idleHandle = null;
}

// A gesture that revealed a pane (tab switch, panel open) makes its containers urgent
function promoteNearViewport() {
    if (!ready || !bootDrained) return;
    // The on-screen containers nearest the gesture point (a revealed pane sits under the click)
    const candidates = [];
    for (const rec of pending) {
        if (rec.urgent || !rec.el.isConnected || !reachable(rec.el)) continue;
        const r = anchorRect(rec);
        rec.near = !!r && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
        if (!rec.near) continue;
        const dx = Math.max(r.left - gestureX, 0, gestureX - r.right);
        const dy = Math.max(r.top - gestureY, 0, gestureY - r.bottom);
        candidates.push([dx * dx + dy * dy, rec]);
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => (a[1].priority - b[1].priority) || (a[0] - b[0])); // authored priority first, then nearest
    let n = 0;
    for (const [, rec] of candidates) { if (n++ >= URGENT_CAP) break; rec.urgent = true; }
    cancelIdle();
    schedule();
}
function onGesture(e) {
    lastGestureAt = now();
    if (e && typeof e.clientX === 'number' && (e.clientX || e.clientY)) { gestureX = e.clientX; gestureY = e.clientY; }
    if (now() - lastPromoteAt < 300) return;
    clearTimeout(promoteTimer);
    lastPromoteAt = now();
    // Three passes: a revealed pane lays out and mounts its menus over the next few hundred ms
    promoteTimer = setTimeout(() => { promoteNearViewport(); promoteTimer = setTimeout(() => { promoteNearViewport(); promoteTimer = setTimeout(promoteNearViewport, 400); }, 150); }, 50);
}

// Only containers the user can reach: not under a hidden route; visible parents first
const reachable = (el) => !el.closest('[x-route][hidden]');
// Judge by the invoker (popovertarget / aria-controls), else the nearest ancestor with a box
// Rect of the invoker or the nearest boxed ancestor (null when nothing has a box)
function anchorRect(rec) {
    const el = rec.el;
    if (!rec.invoker && el.id && window.CSS && CSS.escape) {
        const id = CSS.escape(el.id);
        rec.invoker = document.querySelector(`[popovertarget="${id}"], [aria-controls="${id}"]`) || null;
    }
    let p = (rec.invoker && rec.invoker.isConnected) ? rec.invoker : el.parentElement;
    for (let depth = 0; p && depth < 6; p = p.parentElement, depth++) {
        const r = p.getBoundingClientRect();
        if (r.width || r.height) return r;
    }
    return null;
}
function nearViewport(rec) {
    const r = anchorRect(rec);
    return !!r && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}
function rank(rec) {
    if (rec.near === undefined) rec.near = nearViewport(rec);
    return (rec.urgent ? 0 : 4) + (rec.near ? 0 : 2);
}
function next() {
    let best = null, bestRank = 0;
    for (const rec of pending) {
        if (!rec.el.isConnected) { pending.delete(rec); continue; }
        if (!reachable(rec.el)) continue;
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
    if (!head.urgent && warm.size >= PREWARM_CAP) return;       // paused at the cap; resumes when a warm one opens or evicts
    idleHandle = idle((deadline) => {
        idleHandle = null;
        // Render while the browser reports idle time; the first container of a slice always gets its turn
        let n = 0;
        while (n < SLICE_MAX && (n === 0 || (deadline && deadline.timeRemaining() > IDLE_BUDGET_MS))) {
            if (deadline && deadline.didTimeout) break;
            const rec = next();
            if (!rec) break;
            if (!rec.urgent && warm.size >= PREWARM_CAP) break;   // cap = max warm; only urgent renders may exceed it
            for (const other of pending) other.near = undefined;
            render(rec, true);
            n++;
        }
        evict();
        schedule();
    });
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
    ['pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, onGesture, { capture: true, passive: true }));
    armReady();
}

window.ManifestDefer = {
    enabled: !killed,
    defer,
    render: (el) => { if (el && el.__mnfstDefer) render(el.__mnfstDefer); },
    isPending: (el) => !!(el && el.__mnfstDefer && !el.__mnfstDefer.rendered),
    stats: () => ({ pending: pending.size, warm: warm.size, cap: PREWARM_CAP, ready, bootDrained, armed: idleHandle !== null, head: (() => { const h = next(); return h ? (h.el.id || h.el.tagName) : null; })() })
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
