/* Manifest Data Sources - Pagination (Appwrite) */

// First page, cursor-based
// Returns { items, cursor, total, hasMore }
async function getFirstPage(dataSourceName, limit, baseQueries = []) {
    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        throw new Error('[Manifest Data] Manifest not available');
    }

    const dataSource = manifest.data[dataSourceName];
    if (!dataSource) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" not found`);
    }

    // Check if this is an Appwrite data source
    const isAppwriteTable = window.ManifestDataConfig.isAppwriteCollection(dataSource);
    if (!isAppwriteTable) {
        throw new Error(`[Manifest Data] Pagination is only supported for Appwrite data sources`);
    }

    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
    const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);

    // Build queries with limit
    const queries = [
        ...baseQueries,
        window.Appwrite.Query.limit(limit)
    ];

    let response;
    if (tableId) {
        // Table pagination - need to call Appwrite directly to get full response with total
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.tablesDB) {
            throw new Error('[Manifest Data] Appwrite TablesDB service not available');
        }

        const appwriteResponse = await services.tablesDB.listRows({
            databaseId: appwriteConfig.databaseId,
            tableId: tableId,
            queries: queries
        });

        const items = appwriteResponse.rows || [];
        const total = appwriteResponse.total || 0;
        const cursor = items.length > 0 ? items[items.length - 1].$id : null;
        const hasMore = items.length === limit && total > limit;

        return {
            items,
            cursor,
            total,
            hasMore
        };
    } else if (bucketId) {
        // Storage pagination
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.storage) {
            throw new Error('[Manifest Data] Appwrite Storage service not available');
        }

        const storageResponse = await services.storage.listFiles(bucketId, queries);
        const items = storageResponse.files || [];
        const total = storageResponse.total || 0;
        const cursor = items.length > 0 ? items[items.length - 1].$id : null;
        const hasMore = items.length === limit && total > limit;

        return {
            items,
            cursor,
            total,
            hasMore
        };
    } else {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" is not a table or bucket`);
    }
}

// Next page from cursor
// Returns { items, cursor, total, hasMore }
async function getNextPage(dataSourceName, cursor, limit, baseQueries = []) {
    if (!cursor) {
        throw new Error('[Manifest Data] Cursor is required for next page');
    }

    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        throw new Error('[Manifest Data] Manifest not available');
    }

    const dataSource = manifest.data[dataSourceName];
    if (!dataSource) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" not found`);
    }

    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
    const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);

    // Build queries with cursorAfter and limit
    const queries = [
        ...baseQueries,
        window.Appwrite.Query.cursorAfter(cursor),
        window.Appwrite.Query.limit(limit)
    ];

    let response;
    if (tableId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.tablesDB) {
            throw new Error('[Manifest Data] Appwrite TablesDB service not available');
        }

        const appwriteResponse = await services.tablesDB.listRows({
            databaseId: appwriteConfig.databaseId,
            tableId: tableId,
            queries: queries
        });

        const items = appwriteResponse.rows || [];
        const total = appwriteResponse.total || 0;
        const newCursor = items.length > 0 ? items[items.length - 1].$id : null;
        const hasMore = items.length === limit && total > limit;

        return {
            items,
            cursor: newCursor,
            total,
            hasMore
        };
    } else if (bucketId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.storage) {
            throw new Error('[Manifest Data] Appwrite Storage service not available');
        }

        const storageResponse = await services.storage.listFiles(bucketId, queries);
        const items = storageResponse.files || [];
        const total = storageResponse.total || 0;
        const newCursor = items.length > 0 ? items[items.length - 1].$id : null;
        const hasMore = items.length === limit && total > (limit * 2); // Rough estimate

        return {
            items,
            cursor: newCursor,
            total,
            hasMore
        };
    } else {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" is not a table or bucket`);
    }
}

// Previous page from cursor
// Returns { items, cursor, total, hasMore }
async function getPrevPage(dataSourceName, cursor, limit, baseQueries = []) {
    if (!cursor) {
        throw new Error('[Manifest Data] Cursor is required for previous page');
    }

    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        throw new Error('[Manifest Data] Manifest not available');
    }

    const dataSource = manifest.data[dataSourceName];
    if (!dataSource) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" not found`);
    }

    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
    const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);

    // Build queries with cursorBefore and limit
    const queries = [
        ...baseQueries,
        window.Appwrite.Query.cursorBefore(cursor),
        window.Appwrite.Query.limit(limit)
    ];

    let response;
    if (tableId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.tablesDB) {
            throw new Error('[Manifest Data] Appwrite TablesDB service not available');
        }

        const appwriteResponse = await services.tablesDB.listRows({
            databaseId: appwriteConfig.databaseId,
            tableId: tableId,
            queries: queries
        });

        const items = appwriteResponse.rows || [];
        const total = appwriteResponse.total || 0;
        const newCursor = items.length > 0 ? items[0].$id : null; // First item's ID for going back further
        const hasMore = true; // Can't easily determine if there's a previous page

        return {
            items,
            cursor: newCursor,
            total,
            hasMore
        };
    } else if (bucketId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.storage) {
            throw new Error('[Manifest Data] Appwrite Storage service not available');
        }

        const storageResponse = await services.storage.listFiles(bucketId, queries);
        const items = storageResponse.files || [];
        const total = storageResponse.total || 0;
        const newCursor = items.length > 0 ? items[0].$id : null;
        const hasMore = true;

        return {
            items,
            cursor: newCursor,
            total,
            hasMore
        };
    } else {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" is not a table or bucket`);
    }
}

// Specific page (1-based), offset-based
// Returns { items, page, total, totalPages, hasMore }
async function getPage(dataSourceName, pageNumber, limit, baseQueries = []) {
    if (pageNumber < 1) {
        throw new Error('[Manifest Data] Page number must be >= 1');
    }

    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        throw new Error('[Manifest Data] Manifest not available');
    }

    const dataSource = manifest.data[dataSourceName];
    if (!dataSource) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" not found`);
    }

    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
    const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);

    const offset = (pageNumber - 1) * limit;

    // Build queries with offset and limit
    const queries = [
        ...baseQueries,
        window.Appwrite.Query.offset(offset),
        window.Appwrite.Query.limit(limit)
    ];

    let response;
    let total;
    if (tableId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.tablesDB) {
            throw new Error('[Manifest Data] Appwrite TablesDB service not available');
        }

        const appwriteResponse = await services.tablesDB.listRows({
            databaseId: appwriteConfig.databaseId,
            tableId: tableId,
            queries: queries
        });

        const items = appwriteResponse.rows || [];
        total = appwriteResponse.total || 0;
        const totalPages = Math.ceil(total / limit);
        const hasMore = pageNumber < totalPages;

        return {
            items,
            page: pageNumber,
            total,
            totalPages,
            hasMore
        };
    } else if (bucketId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.storage) {
            throw new Error('[Manifest Data] Appwrite Storage service not available');
        }

        const storageResponse = await services.storage.listFiles(bucketId, queries);
        const items = storageResponse.files || [];
        total = storageResponse.total || 0;
        const totalPages = Math.ceil(total / limit);
        const hasMore = pageNumber < totalPages;

        return {
            items,
            page: pageNumber,
            total,
            totalPages,
            hasMore
        };
    } else {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" is not a table or bucket`);
    }
}

// Export functions
window.ManifestDataPagination = {
    getFirstPage,
    getNextPage,
    getPrevPage,
    getPage
};
