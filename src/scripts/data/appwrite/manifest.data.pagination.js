/* Manifest Data Sources - Pagination (Appwrite) */

// Resolve the source's table or bucket
async function resolvePagedSource(dataSourceName) {
    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        throw new Error('[Manifest Data] Manifest not available');
    }
    const dataSource = manifest.data[dataSourceName];
    if (!dataSource) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" not found`);
    }
    if (!window.ManifestDataConfig.isAppwriteCollection(dataSource)) {
        throw new Error(`[Manifest Data] Pagination is only supported for Appwrite data sources`);
    }
    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
    }
    const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
    const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);
    if (!tableId && !bucketId) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" is not a table or bucket`);
    }
    return { appwriteConfig, tableId, bucketId };
}

// One page request. Asks for limit + 1 rows: the extra row only answers "is there more"
async function fetchPage(dataSourceName, baseQueries, pageQueries, limit) {
    const { appwriteConfig, tableId, bucketId } = await resolvePagedSource(dataSourceName);
    const queries = [...baseQueries, ...pageQueries, window.Appwrite.Query.limit(limit + 1)];
    const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
    let response;
    if (tableId) {
        if (!services?.tablesDB) throw new Error('[Manifest Data] Appwrite TablesDB service not available');
        response = await services.tablesDB.listRows({ databaseId: appwriteConfig.databaseId, tableId, queries });
    } else {
        if (!services?.storage) throw new Error('[Manifest Data] Appwrite Storage service not available');
        response = await services.storage.listFiles(bucketId, queries);
    }
    const rows = (tableId ? response.rows : response.files) || [];
    return { rows, total: response.total || 0, extra: rows.length > limit };
}

// First page, cursor-based. Returns { items, cursor, total, hasMore }
async function getFirstPage(dataSourceName, limit, baseQueries = []) {
    const { rows, total, extra } = await fetchPage(dataSourceName, baseQueries, [], limit);
    const items = rows.slice(0, limit);
    return { items, cursor: items.length ? items[items.length - 1].$id : null, total, hasMore: extra };
}

// Next page after a cursor. Returns { items, cursor, total, hasMore }
async function getNextPage(dataSourceName, cursor, limit, baseQueries = []) {
    if (!cursor) {
        throw new Error('[Manifest Data] Cursor is required for next page');
    }
    const { rows, total, extra } = await fetchPage(dataSourceName, baseQueries, [window.Appwrite.Query.cursorAfter(cursor)], limit);
    const items = rows.slice(0, limit);
    return { items, cursor: items.length ? items[items.length - 1].$id : null, total, hasMore: extra };
}

// Previous page before a cursor. hasMore: rows exist before this page. Returns { items, cursor, total, hasMore }
async function getPrevPage(dataSourceName, cursor, limit, baseQueries = []) {
    if (!cursor) {
        throw new Error('[Manifest Data] Cursor is required for previous page');
    }
    const { rows, total, extra } = await fetchPage(dataSourceName, baseQueries, [window.Appwrite.Query.cursorBefore(cursor)], limit);
    // cursorBefore returns the rows nearest the cursor last; the extra row is the first one
    const items = extra ? rows.slice(rows.length - limit) : rows;
    return { items, cursor: items.length ? items[0].$id : null, total, hasMore: extra };
}

// Specific page (1-based), offset-based. Returns { items, page, total, totalPages, hasMore }
async function getPage(dataSourceName, pageNumber, limit, baseQueries = []) {
    const offset = (pageNumber - 1) * limit;
    const { rows, total, extra } = await fetchPage(dataSourceName, baseQueries, [window.Appwrite.Query.offset(offset)], limit);
    const items = rows.slice(0, limit);
    return { items, page: pageNumber, total, totalPages: Math.ceil(total / limit), hasMore: extra };
}

window.ManifestDataPagination = {
    getFirstPage,
    getNextPage,
    getPrevPage,
    getPage
};
