/* Manifest Tooltips — singleton architecture.
 *
 * Instead of creating one <div popover="hint"> per x-tooltip trigger, this plugin
 * maintains ONE tooltip element per popover host (usually just document.body plus
 * optionally one per open popover). Every trigger with x-tooltip becomes a
 * lightweight content provider that asks the shared controller to show its text,
 * anchored to that trigger.
 *
 * Why: N triggers × 1 tooltip each = N extra DOM nodes that are empty 99% of the
 * time. For dense UIs like colorpicker libraries (~300+ swatches × 20 pickers),
 * this is the difference between a usable page and a laggy one.
 */

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

    // Chain mode: if another tooltip was dismissed this recently, the next one
    // shows immediately (no hover delay). Also used to skip the hide-show flicker
    // when gliding across many triggers — the singleton just re-anchors.
    const TOOLTIP_CHAIN_GRACE_MS = 250;
    let _lastTooltipHideTime = 0;
    const markTooltipHidden = () => { _lastTooltipHideTime = Date.now(); };
    const clearChainWindow = () => { _lastTooltipHideTime = 0; };
    const isInChainWindow = () => (Date.now() - _lastTooltipHideTime) < TOOLTIP_CHAIN_GRACE_MS;

    // ---- Singletons per host ----
    //
    // Most pages only need one singleton (under document.body). Open popovers (menus,
    // dialogs) require their own singleton because CSS anchor positioning can't resolve
    // across the top-layer boundary. We create them lazily on first use and keep them
    // (small, hidden <div>s) for the life of the host.
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
    //
    // Single pending-show timer shared across the whole plugin. If a trigger arms a
    // show and the user moves to another trigger before it fires, the first timer is
    // cancelled in favor of the new one. If the singleton is already visible, the new
    // trigger updates it in place (chain mode) — no hide/show flicker.

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


    // Update the singleton to point at a trigger (anchor, content, classes) and show it.
    // Switches between triggers happen by re-anchoring — no positional animation. Any
    // previous transform state is cleared so the tooltip sits squarely at its anchor.
    function showSingletonFor(trigger, contentHtml, positions) {
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

        s.el.innerHTML = contentHtml || '';

        // Anchor binding: reuse or assign the trigger's anchor, point the singleton at it.
        const anchorName = resolveTriggerAnchor(trigger);
        s.el.style.setProperty('position-anchor', anchorName);

        s.activeTrigger = trigger;
        s.currentAnchorName = anchorName;

        // A11y: link the trigger to the tooltip so screen readers announce the
        // tooltip text as a description when the trigger receives focus or hover.
        // Per WAI-ARIA, aria-describedby is the standard for this relationship.
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
            try { el.hidePopover(); } catch {}
        });
        // Restore each tooltip's prior aria-describedby on the trigger it had been
        // bound to. We can't reach the trigger from the popover alone, so we walk
        // the tooltipped triggers and remove our id from their describedby list.
        document.querySelectorAll('[aria-describedby]').forEach((el) => {
            if (!el._tooltipPriorDescribedBy && el._tooltipPriorDescribedBy !== '') return;
            const prior = el._tooltipPriorDescribedBy;
            if (prior) el.setAttribute('aria-describedby', prior);
            else el.removeAttribute('aria-describedby');
            el._tooltipPriorDescribedBy = undefined;
        });
        // Only arm the chain window when something was actually open — marking
        // unconditionally let a plain click fast-track the next focus show.
        if (wasOpen) markTooltipHidden();
    }

    // ---- Directive ----

    Alpine.directive('tooltip', (el, { modifiers, expression }, { effect, evaluateLater }) => {

        // --- Content evaluator ---
        let getContent;
        const isDynamic =
            expression.startsWith('$x.') ||
            (expression.includes('+') || expression.includes('`') || expression.includes('${'));

        if (expression.startsWith('$x.')) {
            const path = expression.substring(3);
            const [contentType] = path.split('.');
            getContent = evaluateLater(expression);
            effect(() => {
                const store = Alpine.store('collections');
                if (store && typeof store.loadCollection === 'function' && !store[contentType]) {
                    store.loadCollection(contentType);
                }
            });
        } else if (expression.includes('<') && expression.includes('>')) {
            // Literal HTML string
            const escaped = expression.replace(/'/g, "\\'");
            getContent = evaluateLater(`'${escaped}'`);
        } else if (expression.includes('+') || expression.includes('`') || expression.includes('${')) {
            getContent = evaluateLater(expression);
        } else {
            // Static literal — wrap in quotes so evaluateLater returns it verbatim
            getContent = evaluateLater(`'${expression}'`);
        }

        // --- Positioning modifiers ---
        const validPositions = ['top', 'bottom', 'start', 'end', 'center', 'corner'];
        const positions = modifiers.filter(m => validPositions.includes(m));

        // For non-dynamic content, cache once to avoid re-evaluating every show.
        let cachedContent = null;
        if (!isDynamic) {
            getContent(v => { cachedContent = v; });
        }

        // Resolves the content to show, calling the provided callback with the HTML string.
        const resolveContent = (cb) => {
            if (!isDynamic && cachedContent != null) { cb(cachedContent); return; }
            getContent(v => cb(v));
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
                resolveContent(html => {
                    showSingletonFor(el, html, positions);
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

        // Keyboard / focus interactions — WCAG 2.1 SC 1.4.13 requires tooltip
        // content to be accessible to keyboard users via focus, not hover only.
        // Gated on :focus-visible so mouse-click focus doesn't flash the tooltip.
        el.addEventListener('focus', () => {
            if (el.matches(':focus-visible')) requestShow();
        });
        el.addEventListener('blur', requestHide);

        // Mousedown/click hides immediately and clears the chain window so a
        // synthetic re-hover (e.g. content shifting under the cursor after
        // navigation) waits the full delay instead of showing instantly.
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
    //
    // Flash a tooltip in response to an action (e.g. the code plugin's inline
    // copy confirmation) without requiring the trigger to carry an x-tooltip
    // directive. The trigger element acts as the anchor; the singleton is
    // reused, so this respects chain mode / focus behaviour just like a
    // hover-shown tooltip would. Auto-hides after `durationMs`.
    //
    // `positions` accepts the same vocabulary as the x-tooltip directive's
    // modifiers — array of any subset of ['top','bottom','start','end',
    // 'center','corner']. Joined with '-' to form the position class
    // (e.g. ['top','end'] → '.top-end'), matching what `x-tooltip.top.end`
    // would emit.
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
