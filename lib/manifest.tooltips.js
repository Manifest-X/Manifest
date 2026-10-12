/* Manifest Tooltips */

(function () {


// Hover delay from CSS var (with time-unit parsing). Defaults to 500ms.
function getTooltipHoverDelay(element) {
    let computedStyle = getComputedStyle(element);
    let delayValue = computedStyle.getPropertyValue('--tooltip-hover-delay').trim();
    if (!delayValue) {
        computedStyle = getComputedStyle(document.documentElement);
        delayValue = computedStyle.getPropertyValue('--tooltip-hover-delay').trim();
    }
    if (!delayValue) return 500;
    const timeValue = parseFloat(delayValue);
    if (delayValue.endsWith('ms')) return timeValue;
    if (delayValue.endsWith('s')) return timeValue * 1000;
    if (delayValue.endsWith('min') || delayValue.endsWith('m') || delayValue.endsWith('minute')) return timeValue * 60 * 1000;
    if (delayValue.endsWith('h') || delayValue.endsWith('hour')) return timeValue * 60 * 60 * 1000;
    if (delayValue.endsWith('sec') || delayValue.endsWith('second')) return timeValue * 1000;
    return timeValue; // unitless → ms
}

// Popover host for anchor positioning: the closest top-layer popover ancestor, or body.
function getTooltipHostForTrigger(triggerEl) {
    return triggerEl.closest('[popover]') || document.body;
}

function initializeTooltipPlugin() {

    // Chain mode: a recently-dismissed tooltip lets the next show immediately (no
    // delay), and gliding across triggers re-anchors the singleton without flicker.
    const TOOLTIP_CHAIN_GRACE_MS = 250;
    let _lastTooltipHideTime = 0;
    const markTooltipHidden = () => { _lastTooltipHideTime = Date.now(); };
    const clearChainWindow = () => { _lastTooltipHideTime = 0; };
    const isInChainWindow = () => (Date.now() - _lastTooltipHideTime) < TOOLTIP_CHAIN_GRACE_MS;

    // ---- Singletons per host ----
    // One under document.body; open popovers (menus, dialogs) need their own because
    // CSS anchor positioning can't resolve across the top-layer boundary. Created
    // lazily, kept for the host's life.
    const _singletons = new WeakMap();

    function getSingleton(host) {
        let s = _singletons.get(host);
        if (s) return s;
        const el = document.createElement('div');
        el.setAttribute('popover', 'hint');
        el.className = 'tooltip';
        host.appendChild(el);
        s = {
            el,
            host,
            activeTrigger: null,
            currentPositions: [],
            currentAnchorName: null
        };
        _singletons.set(host, s);
        return s;
    }

    // Reuse the trigger's own anchor (--trigger-anchor) or assign one once;
    // never overwrite or restore another plugin's anchor-name
    function resolveTriggerAnchor(trigger) {
        const owned = trigger.style.getPropertyValue('--trigger-anchor').trim();
        if (owned) return owned;
        if (!trigger._tooltipAnchorSet) {
            const code = Math.random().toString(36).slice(2, 9);
            trigger._tooltipAnchorName = `--tooltip-${code}`;
            trigger.style.setProperty('anchor-name', `${trigger._tooltipAnchorName}, var(--co-anchor, --no-anchor)`);
            trigger._tooltipAnchorSet = true;
            void trigger.offsetHeight;
        }
        return trigger._tooltipAnchorName;
    }

    // ---- Controller ----
    // One shared pending-show timer: moving to another trigger cancels the first. If
    // the singleton is already visible, the new trigger updates it in place (chain mode).
    let _showTimer = null;
    let _pendingTrigger = null;
    // Hide is deferred briefly so an incoming show on a different trigger can take
    // over (chain-mode glide) instead of producing a hide/show flicker.
    let _hideTimer = null;
    const HIDE_DEFER_MS = 60;

    function cancelPendingShow() {
        if (_showTimer) { clearTimeout(_showTimer); _showTimer = null; }
        _pendingTrigger = null;
    }
    function cancelPendingHide() {
        if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    }


    // Point the singleton at a trigger (anchor, content, classes) and show it. Switches
    // re-anchor with no animation; residual transform state is cleared.
    function showSingletonFor(trigger, contentHtml, positions, allowHtml = true) {
        const host = getTooltipHostForTrigger(trigger);
        const s = getSingleton(host);

        // Clear any residual transform state (defensive — should already be clean)
        s.el.style.transition = '';
        s.el.style.translate = '';

        // Update position classes on the singleton. These drive the CSS positioning
        // variants (top, bottom-end, etc.) defined in manifest.tooltip.css.
        if (s.currentPositions.length) s.el.classList.remove(s.currentPositions.join('-'));
        if (positions.length) s.el.classList.add(positions.join('-'));
        s.currentPositions = positions;

        // Escape by default (dynamic content can carry attacker markup); author HTML
        // and the .html/.safe opt-in render as markup.
        if (allowHtml) s.el.innerHTML = contentHtml || '';
        else s.el.textContent = contentHtml || '';

        // Anchor binding: reuse or assign the trigger's anchor, point the singleton at it.
        const anchorName = resolveTriggerAnchor(trigger);
        s.el.style.setProperty('position-anchor', anchorName);

        s.activeTrigger = trigger;
        s.currentAnchorName = anchorName;

        // A11y: aria-describedby links trigger → tooltip for screen readers.
        if (!s.el.id) s.el.id = 'mnfst-tooltip-' + Math.random().toString(36).slice(2, 9);
        s.el.setAttribute('role', 'tooltip');
        // Preserve any author-provided aria-describedby so we don't stomp it.
        if (!trigger._tooltipPriorDescribedBy) {
            trigger._tooltipPriorDescribedBy = trigger.getAttribute('aria-describedby') || '';
        }
        const prior = trigger._tooltipPriorDescribedBy;
        const merged = prior ? `${prior} ${s.el.id}` : s.el.id;
        trigger.setAttribute('aria-describedby', merged);

        if (!s.el.matches(':popover-open')) s.el.showPopover();
    }

    // Hide the singleton that's currently showing (if any), regardless of host.
    function hideAnySingleton() {
        let wasOpen = false;
        document.querySelectorAll('.tooltip[popover="hint"]:popover-open').forEach(el => {
            wasOpen = true;
            try { el.hidePopover(); } catch { }
        });
        // Restore each trigger's prior aria-describedby (can't reach it from the
        // popover, so walk tooltipped triggers).
        document.querySelectorAll('[aria-describedby]').forEach((el) => {
            if (!el._tooltipPriorDescribedBy && el._tooltipPriorDescribedBy !== '') return;
            const prior = el._tooltipPriorDescribedBy;
            if (prior) el.setAttribute('aria-describedby', prior);
            else el.removeAttribute('aria-describedby');
            el._tooltipPriorDescribedBy = undefined;
        });
        // Only arm the chain window when something was open (else a plain click
        // would fast-track the next focus show).
        if (wasOpen) markTooltipHidden();
    }

    // ---- Content classification ----
    // Any JS expression evaluates; text that isn't one renders verbatim.

    const BARE_IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u;
    const looksLikeHtml = (s) => s.includes('<') && s.includes('>');

    function parsesAsExpression(src) {
        try { new Function('return (' + src + '\n)'); return true; } catch { return false; }
    }

    function inScope(el, name) {
        try { return name in Alpine.$data(el); } catch { return false; }
    }

    // Errors come back as values: unresolved names read as plain text
    // ("Re-run", "Hello, world"); other errors warn against the authored expression
    const guarded = (src) =>
        '(() => { try { return (' + src + '\n) } catch (e) { return { __tooltipError: e } } })()';

    function unwrapError(v, el, src) {
        const err = v && typeof v === 'object' && v.__tooltipError;
        if (!(err instanceof Error)) return { value: v };
        if (err instanceof ReferenceError) return { value: undefined };
        console.warn(`Alpine Expression Error: ${err.message}\n\nExpression: "${src}"\n\n`, el);
        return { value: null };
    }

    // ---- Directive ----

    Alpine.directive('tooltip', (el, { modifiers, expression }, { effect, evaluateLater }) => {

        // --- Content ---
        // Escape by default; author literal HTML or .html/.safe opts in.
        const htmlOptIn = modifiers.includes('html') || modifiers.includes('safe');
        const literal = expression ? { text: expression, html: htmlOptIn || looksLikeHtml(expression) } : null;
        const src = expression.trim();
        let evaluate = null;
        let fallback = true;

        if (src.startsWith('$x.')) {
            const [contentType] = src.substring(3).split('.');
            evaluate = evaluateLater(src);
            fallback = false;
            effect(() => {
                const store = Alpine.store('collections');
                if (store && typeof store.loadCollection === 'function' && !store[contentType]) {
                    store.loadCollection(contentType);
                }
            });
        } else if (BARE_IDENTIFIER.test(src)) {
            // Single word: a scope value or magic, else text (never a global like Image or close)
            const getValue = evaluateLater(guarded(src));
            evaluate = (cb) => (src.startsWith('$') || inScope(el, src)) ? getValue(cb) : cb(undefined);
        } else if (parsesAsExpression(src)) {
            evaluate = evaluateLater(guarded(src));
        }

        // --- Positioning modifiers ---
        const validPositions = ['top', 'bottom', 'start', 'end', 'center', 'corner'];
        const positions = modifiers.filter(m => validPositions.includes(m));

        // Static text resolves once; expressions re-evaluate on every show.
        // Empty results (null, false, '') show nothing.
        const resolveContent = (cb) => {
            if (!evaluate) { cb(literal); return; }
            evaluate(raw => {
                const v = fallback ? unwrapError(raw, el, src).value : raw;
                if (fallback && (v === undefined || Number.isNaN(v))) { cb(literal); return; }
                if (v == null || v === false || v === '') { cb(null); return; }
                cb({ text: String(v), html: htmlOptIn });
            });
        };

        // --- Event handlers ---
        const requestShow = () => {
            cancelPendingShow();
            cancelPendingHide(); // incoming show cancels the deferred hide — this is the glide takeover
            _pendingTrigger = el;
            // Chain mode: if the singleton is still open (hide was deferred, about to
            // happen), or was just dismissed within the grace window, show now.
            const anyOpen = document.querySelector('.tooltip[popover="hint"]:popover-open');
            const delay = (anyOpen || isInChainWindow()) ? 0 : getTooltipHoverDelay(el);
            _showTimer = setTimeout(() => {
                _showTimer = null;
                if (_pendingTrigger !== el) return;
                const triggerTargetId = el.getAttribute('popovertarget') || el.getAttribute('x-dropdown');
                if (triggerTargetId) {
                    const t = document.getElementById(triggerTargetId);
                    if (t && t.matches && t.matches(':popover-open')) return;
                }
                resolveContent(content => {
                    if (content) showSingletonFor(el, content.text, positions, content.html);
                    else hideAnySingleton();
                });
            }, delay);
        };

        const requestHide = () => {
            cancelPendingShow();
            // Defer the actual hide briefly so an incoming show on a different trigger
            // can take over (chain mode: immediate show) rather than flicker-close.
            cancelPendingHide();
            _hideTimer = setTimeout(() => {
                _hideTimer = null;
                const host = getTooltipHostForTrigger(el);
                const s = _singletons.get(host);
                if (s && s.activeTrigger === el && s.el.matches(':popover-open')) {
                    s.el.hidePopover();
                    s.activeTrigger = null;
                    markTooltipHidden();
                }
            }, HIDE_DEFER_MS);
        };

        // Mouse interactions
        el.addEventListener('mouseenter', requestShow);
        el.addEventListener('mouseleave', requestHide);

        // Keyboard focus (WCAG 2.1 SC 1.4.13). Gated on :focus-visible so mouse-click
        // focus doesn't flash the tooltip.
        el.addEventListener('focus', () => {
            if (el.matches(':focus-visible')) requestShow();
        });
        el.addEventListener('blur', requestHide);

        // Mousedown/click hides now and clears the chain window, so a synthetic
        // re-hover (content shifting under the cursor) waits the full delay.
        const hideOnInteraction = () => {
            cancelPendingShow();
            hideAnySingleton();
            clearChainWindow();
        };
        el.addEventListener('mousedown', hideOnInteraction);
        el.addEventListener('click', hideOnInteraction);
    });

    // Global: when ANY other popover opens, close the singleton(s). Dropdowns and
    // dialogs take precedence over tooltips.
    document.addEventListener('toggle', (event) => {
        if (event.newState !== 'open') return;
        const t = event.target;
        if (t.classList && t.classList.contains('tooltip') && t.getAttribute('popover') === 'hint') return;
        hideAnySingleton();
    }, true);

    // ---- Public programmatic-show API ----
    // Flash a tooltip for an action (e.g. code plugin's copy confirmation) without an
    // x-tooltip directive; the trigger is the anchor, the singleton is reused. Auto-
    // hides after `durationMs`. `positions` is the directive modifier vocabulary
    // (subset of ['top','bottom','start','end','center','corner'], joined with '-').
    window.ManifestTooltips = window.ManifestTooltips || {};
    window.ManifestTooltips.showTransient = function (triggerEl, contentHtml, durationMs, positions) {
        if (!triggerEl) return;
        const duration = typeof durationMs === 'number' ? durationMs : 1500;
        const validPositions = ['top', 'bottom', 'start', 'end', 'center', 'corner'];
        let resolvedPositions = [];
        if (Array.isArray(positions)) {
            resolvedPositions = positions.filter(p => validPositions.includes(p));
        } else if (typeof positions === 'string' && positions) {
            resolvedPositions = positions.split(/[.\-\s]+/).filter(p => validPositions.includes(p));
        }
        cancelPendingShow();
        cancelPendingHide();
        showSingletonFor(triggerEl, contentHtml || '', resolvedPositions);
        clearTimeout(triggerEl._tooltipTransientTimer);
        triggerEl._tooltipTransientTimer = setTimeout(() => {
            triggerEl._tooltipTransientTimer = null;
            const host = getTooltipHostForTrigger(triggerEl);
            const s = _singletons.get(host);
            if (s && s.activeTrigger === triggerEl && s.el.matches(':popover-open')) {
                try { s.el.hidePopover(); } catch { /* popover already closed */ }
                s.activeTrigger = null;
                markTooltipHidden();
            }
        }, duration);
    };

    // ---- Copy buttons ----
    // button[command="--copy"] copies its label's field (or the [commandfor]
    // target) and flashes a confirmation: the button's [value] text, else a
    // check icon. Styled by manifest.input.css.
    document.addEventListener('click', async (event) => {
        const btn = event.target.closest ? event.target.closest('button[command="--copy"]') : null;
        if (!btn) return;
        event.preventDefault();
        const forId = btn.getAttribute('commandfor');
        const source = forId
            ? document.getElementById(forId)
            : (btn.closest('label, .label') || btn.parentElement)?.querySelector('input, textarea, select');
        if (!source) return;
        try {
            await navigator.clipboard.writeText(source.value ?? source.textContent);
            const custom = (btn.value || '').trim();
            const content = custom
                ? custom.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
                : '<span class="field-copied-icon" aria-hidden="true"></span>';
            window.ManifestTooltips.showTransient(btn, content, 1500, ['top', 'end']);
        } catch { /* clipboard rejected (browser permissions) — fail silently */ }
    });
}

// ---- Plugin init boilerplate ----

let tooltipPluginInitialized = false;

function ensureTooltipPluginInitialized() {
    if (tooltipPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
    tooltipPluginInitialized = true;
    initializeTooltipPlugin();
}

window.ensureTooltipPluginInitialized = ensureTooltipPluginInitialized;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureTooltipPluginInitialized);
}
document.addEventListener('alpine:init', ensureTooltipPluginInitialized);

if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureTooltipPluginInitialized, 0);
} else {
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureTooltipPluginInitialized();
        }
    }, 50);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}


})();
