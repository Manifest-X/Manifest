/* Manifest Data Sources - Cloud API Loader */
// Basic read-only API support, included in core for localization compatibility

// Load from API endpoint (read-only)
async function loadFromAPI(dataSource) {
    try {
        const url = new URL(window.ManifestDataConfig.interpolateEnvVars(dataSource.url));

        // Add query parameters
        if (dataSource.params) {
            Object.entries(dataSource.params).forEach(([key, value]) => {
                url.searchParams.set(key, window.ManifestDataConfig.interpolateEnvVars(value));
            });
        }

        // Prepare headers
        const headers = {};
        if (dataSource.headers) {
            Object.entries(dataSource.headers).forEach(([key, value]) => {
                headers[key] = window.ManifestDataConfig.interpolateEnvVars(value);
            });
        }

        const response = await fetch(url, {
            method: dataSource.method || 'GET',
            headers: headers
        });

        if (!response.ok) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        let data = await response.json();

        // Transform data if needed
        if (dataSource.transform) {
            data = window.ManifestDataConfig.getNestedValue(data, dataSource.transform);
        }

        return data;
    } catch (error) {
        console.error(`[Manifest Data] Failed to load API dataSource:`, error);
        // Return empty array/object to prevent breaking the UI
        return Array.isArray(dataSource.defaultValue) ? dataSource.defaultValue : (dataSource.defaultValue || []);
    }
}

// Export functions to window for use by other subscripts
window.ManifestDataAPI = {
    loadFromAPI
};

