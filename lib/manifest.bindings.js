/* Manifest Bindings */

(function () {

// x-text: same as Alpine's, but never rewrites an unchanged string (each write is a DOM mutation)
function initializeBindingsPlugin() {
    Alpine.directive('text', (el, { expression }, { effect, evaluateLater }) => {
        const evaluate = evaluateLater(expression);
        effect(() => {
            evaluate((value) => {
                const next = value == null ? '' : String(value);
                if (el.textContent === next) return;
                Alpine.mutateDom(() => { el.textContent = next; });
            });
        });
    });
}

let bindingsPluginInitialized = false;

function ensureBindingsPluginInitialized() {
    if (bindingsPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
    bindingsPluginInitialized = true;
    initializeBindingsPlugin();
}

document.addEventListener('alpine:init', ensureBindingsPluginInitialized);
if (window.Alpine && typeof window.Alpine.directive === 'function') ensureBindingsPluginInitialized();

})();
