/* Manifest Data Sources - Route & Proxy Coordinator */
// Proxy creation lives in proxies/creation/*; those modules self-export to
// window.ManifestDataProxies. This file only ensures the namespace exists.
if (typeof window !== 'undefined') {
    if (!window.ManifestDataProxies) {
        window.ManifestDataProxies = {};
    }
}
