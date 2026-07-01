/* Manifest Data Sources - Magic Method State Properties */
// $loading, $error, $ready state properties

function getStateProperty(prop, dataSourceName) {
    if (typeof Alpine === 'undefined' || !Alpine.store) {
        return prop === '$loading' ? false : (prop === '$error' ? null : false);
    }

    const store = Alpine.store('data');
    if (!store) {
        return prop === '$loading' ? false : (prop === '$error' ? null : false);
    }

    const stateKey = `_${dataSourceName}_state`;
    const state = store[stateKey] || { loading: false, error: null, ready: false };

    if (prop === '$loading') {
        return state.loading !== false; // Default to true if loading
    } else if (prop === '$error') {
        return state.error || null;
    } else if (prop === '$ready') {
        return state.ready || false;
    }

    return undefined;
}

// State property handler for use in proxy get() traps
function createStatePropertyHandler(dataSourceName) {
    return function (key) {
        if (key === '$loading' || key === '$error' || key === '$ready') {
            return getStateProperty(key, dataSourceName);
        }
        return undefined;
    };
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxiesMagic) {
    window.ManifestDataProxiesMagic = {};
}
window.ManifestDataProxiesMagic.getStateProperty = getStateProperty;
window.ManifestDataProxiesMagic.createStatePropertyHandler = createStatePropertyHandler;

