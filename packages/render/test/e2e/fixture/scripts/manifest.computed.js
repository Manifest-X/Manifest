/* Manifest Computed */

(function () {

// $computed(fn): cached derivation — recomputed once per flush when a tracked dependency changes
function computed(fn) {
    if (typeof fn !== 'function') throw new TypeError('[Manifest Computed] $computed expects a function');
    return Alpine.interceptor(() => {}, obj => {
        obj.initialize = (data, path, key) => install(data, key, fn);
    })(fn);
}

function install(data, key, fn) {
    let value;
    let failed = false;
    let first = true;

    const compute = () => {
        try {
            value = fn.call(data, data);   // `this` and the first argument are both the scope
            failed = false;
        } catch (error) {
            // Keep the last good value; report once per failure streak
            if (!failed) console.warn(`[Manifest Computed] "${key}" threw — keeping its last value`, error);
            failed = true;
        }
        return value;
    };

    const effect = Alpine.effect(() => {
        const next = compute();
        if (first) { first = false; return; }
        data[key] = next;
    });

    // Release with the owning element (stores have no $el and live for the page)
    const el = data.$el;
    if (el) Alpine.onElRemoved(el, () => Alpine.release(effect));

    return value;
}

function initializeComputedPlugin() {
    Alpine.magic('computed', () => computed);

    // x-computed:name="expression" — a cached value on the nearest scope, recomputed once per change
    Alpine.directive('computed', (el, { value, expression }, { effect, evaluateLater }) => {
        if (!value) { console.warn('[Manifest Computed] x-computed needs a name: x-computed:total="a + b"'); return; }
        const evaluate = evaluateLater(expression);
        // Write to the NEAREST data object, not through the merged proxy (which puts new keys on the root scope)
        const stack = Alpine.closestDataStack(el);
        const scope = stack[0] || Alpine.$data(el);
        effect(() => { evaluate((next) => { scope[value] = next; }); });   // a failed evaluation keeps the last value
    }).before('init');   // so x-init / x-show on the same element can read the value
}

window.$computed = computed;

document.addEventListener('alpine:init', initializeComputedPlugin);
if (window.Alpine && typeof window.Alpine.magic === 'function') initializeComputedPlugin();

})();
