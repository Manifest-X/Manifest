/* Manifest Data Sources - Magic Method Pagination Handlers */
// $first, $next, $prev, $page

function createPaginationMethod(methodName, dataSourceName) {
    return async function (...args) {
        const manifest = await window.ManifestDataConfig.ensureManifest();
        if (!manifest?.data) {
            throw new Error('[Manifest Data] Manifest not available');
        }

        const dataSource = manifest.data[dataSourceName];
        if (!dataSource || !window.ManifestDataConfig.isAppwriteCollection(dataSource)) {
            throw new Error(`[Manifest Data] Pagination is only supported for Appwrite data sources`);
        }

        // Base queries from manifest or scope
        const scope = window.ManifestDataConfig.getScope(dataSource);
        const queriesConfig = window.ManifestDataConfig.getQueries(dataSource);
        const baseQueries = queriesConfig
            ? await window.ManifestDataQueries.buildAppwriteQueries(queriesConfig.default || queriesConfig, scope)
            : await window.ManifestDataQueries.buildAppwriteQueries([], scope);

        if (methodName === '$first') {
            const limit = args[0] || 10;
            return await window.ManifestDataPagination.getFirstPage(dataSourceName, limit, baseQueries);
        } else if (methodName === '$next') {
            const [cursor, limit = 10] = args;
            if (!cursor) {
                throw new Error('[Manifest Data] Cursor is required for $next');
            }
            return await window.ManifestDataPagination.getNextPage(dataSourceName, cursor, limit, baseQueries);
        } else if (methodName === '$prev') {
            const [cursor, limit = 10] = args;
            if (!cursor) {
                throw new Error('[Manifest Data] Cursor is required for $prev');
            }
            return await window.ManifestDataPagination.getPrevPage(dataSourceName, cursor, limit, baseQueries);
        } else if (methodName === '$page') {
            const [pageNumber, limit = 10] = args;
            if (!pageNumber || pageNumber < 1) {
                throw new Error('[Manifest Data] Page number must be >= 1');
            }
            return await window.ManifestDataPagination.getPage(dataSourceName, pageNumber, limit, baseQueries);
        }
    };
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxiesMagic) {
    window.ManifestDataProxiesMagic = {};
}
window.ManifestDataProxiesMagic.createPaginationMethod = createPaginationMethod;

