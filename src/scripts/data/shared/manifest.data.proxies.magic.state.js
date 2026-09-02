/* Manifest Data Sources - Magic Method State Properties */
// $loading, $error, $ready, $stale, $fresh state properties
//
// $stale: true until the first network-fresh landing of this page-load is
//   applied (rows from a fetch, `$query`, or the memory cache of a fetch made
//   this page-load); false from then on — a later reload keeps it false and
//   reports through $loading. Single-reveal UIs gate on `!$stale`.
// $fresh: promise resolving at that same first fresh landing; never rejects
//   (a failed reload keeps old rows and sets $error). Per page-load.

const STATE_PROPS = ['$loading', '$error', '$ready', '$stale', '$fresh'];

function defaultStateValue(prop) {
    if (prop === '$error') return null;
    if (prop === '$stale') return true;
    return false;
}

function getStateProperty(prop, dataSourceName) {
    if (prop === '$fresh') {
        return window.ManifestDataStore?.sourceFreshness?.(dataSourceName)?.promise || Promise.resolve();
    }

    if (typeof Alpine === 'undefined' || !Alpine.store) {
        return defaultStateValue(prop);
    }

    const store = Alpine.store('data');
    if (!store) {
        return defaultStateValue(prop);
    }

    const stateKey = `_${dataSourceName}_state`;
    const state = store[stateKey] || { loading: false, error: null, ready: false, stale: true };

    if (prop === '$loading') {
        return state.loading !== false; // Default to true if loading
    } else if (prop === '$error') {
        return state.error || null;
    } else if (prop === '$ready') {
        return state.ready || false;
    } else if (prop === '$stale') {
        return state.stale !== false;
    }

    return undefined;
}

// State property handler for use in proxy get() traps
function createStatePropertyHandler(dataSourceName) {
    return function (key) {
        if (STATE_PROPS.includes(key)) {
            return getStateProperty(key, dataSourceName);
        }
        return undefined;
    };
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxiesMagic) {
    window.ManifestDataProxiesMagic = {};
}
window.ManifestDataProxiesMagic.STATE_PROPS = STATE_PROPS;
window.ManifestDataProxiesMagic.getStateProperty = getStateProperty;
window.ManifestDataProxiesMagic.createStatePropertyHandler = createStatePropertyHandler;
