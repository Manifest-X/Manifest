/* Manifest Data Sources - Magic Method Pagination Handlers */
// $first, $next, $prev, $page

const PAGE_WINDOW_METHODS = new Set(['limit', 'offset', 'cursorAfter', 'cursorBefore']);

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
        const scopeColumns = window.ManifestDataConfig.getScopeColumns(dataSource);
        // Pages follow the active $query, else the default queries; paging supplies its own window
        const queriesConfig = window.ManifestDataConfig.getQueries(dataSource);
        const defaults = queriesConfig ? (queriesConfig.default || queriesConfig) : [];
        const active = window.ManifestDataMain?.getActiveQuery?.(dataSourceName);
        const filters = (Array.isArray(active) ? active : (Array.isArray(defaults) ? defaults : []))
            .filter(q => !(Array.isArray(q) && PAGE_WINDOW_METHODS.has(q[0])));
        let baseQueries = await window.ManifestDataQueries.buildAppwriteQueries(filters, scope, scopeColumns);
        if (baseQueries === null) {
            // A $auth. value or scope not resolved yet: wait for auth once
            await window.ManifestDataMain?.waitForAuthChange?.();
            baseQueries = await window.ManifestDataQueries.buildAppwriteQueries(filters, scope, scopeColumns);
        }
        if (baseQueries === null) {
            throw new Error(`[Manifest Data] "${dataSourceName}" pagination: auth not ready — sign in, or check the $auth. values in its queries`);
        }

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

