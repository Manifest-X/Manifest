/* Manifest Data Sources - Magic Method $upload Handler */
// $upload: upload files and link them to a table entry

function createUploadMethod(dataSourceName, reloadDataSource) {
    return async function (entryId, fileOrEvent, bucketName) {
        const manifest = await window.ManifestDataConfig.ensureManifest();
        if (!manifest?.data) {
            throw new Error('[Manifest Data] Manifest not available');
        }

        const tableDataSource = manifest.data[dataSourceName];
        if (!tableDataSource || !window.ManifestDataConfig.getAppwriteTableId(tableDataSource)) {
            throw new Error(`[Manifest Data] "${dataSourceName}" is not an Appwrite table`);
        }

        if (!entryId) {
            throw new Error(`[Manifest Data] Entry ID is required for $upload()`);
        }

        // Extract file(s) from event or use file object directly
        let files = [];
        if (fileOrEvent?.target?.files) {
            // Event object - extract files
            files = Array.from(fileOrEvent.target.files);
            // Clear input value after extraction
            if (fileOrEvent.target) {
                fileOrEvent.target.value = '';
            }
        } else if (fileOrEvent instanceof File || fileOrEvent instanceof Blob) {
            // Direct file object
            files = [fileOrEvent];
        } else if (Array.isArray(fileOrEvent)) {
            // Array of files
            files = fileOrEvent.filter(f => f instanceof File || f instanceof Blob);
        } else {
            throw new Error(`[Manifest Data] Invalid file or event object. Expected File, Blob, Event, or array of files.`);
        }

        if (files.length === 0) {
            throw new Error(`[Manifest Data] No files provided for upload`);
        }

        // Determine bucket name
        let resolvedBucketName = bucketName;
        if (!resolvedBucketName) {
            const getDefaultBucketForTable = window.ManifestDataProxiesFiles?.getDefaultBucketForTable;
            if (getDefaultBucketForTable) {
                resolvedBucketName = getDefaultBucketForTable(dataSourceName);
            }
            if (!resolvedBucketName) {
                throw new Error(`[Manifest Data] Multiple storage buckets configured for "${dataSourceName}". Please specify bucket name: $x.${dataSourceName}.$upload(entryId, fileOrEvent, 'bucketName')`);
            }
        }

        // Get storage config
        const storageConfig = window.ManifestDataProxiesFiles?.parseStorageConfig(tableDataSource, resolvedBucketName);
        if (!storageConfig) {
            throw new Error(`[Manifest Data] Storage bucket "${resolvedBucketName}" not configured for table "${dataSourceName}"`);
        }

        const resolvedColumnName = storageConfig.column || 'fileIds';

        // Get bucket data source to access $create method
        const bucketDataSource = manifest.data[resolvedBucketName];
        if (!bucketDataSource || !window.ManifestDataConfig.getAppwriteBucketId(bucketDataSource)) {
            throw new Error(`[Manifest Data] Storage bucket "${resolvedBucketName}" not found in manifest`);
        }

        // Get $x to access bucket methods
        const $x = window.Alpine?.magic?.('x')?.();
        if (!$x || !$x[resolvedBucketName] || typeof $x[resolvedBucketName].$create !== 'function') {
            throw new Error(`[Manifest Data] Bucket "${resolvedBucketName}" is not available`);
        }

        // Get helper functions for uploading state
        const { setUploadingFile, clearUploadingFile } = window.ManifestDataStore || {};

        // Generate temporary file IDs for tracking upload state
        const fileIds = files.map(file => {
            if (window.Appwrite && window.Appwrite.ID) {
                return window.Appwrite.ID.unique();
            }
            return `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        });

        // Set uploading state for all files
        if (setUploadingFile) {
            fileIds.forEach(fileId => {
                setUploadingFile(dataSourceName, entryId, fileId);
            });
        }

        try {
            // Upload files (single or multiple)
            const uploadPromises = files.map((file, index) => {
                const tempFileId = fileIds[index];
                return $x[resolvedBucketName].$create(file, tempFileId, null, {
                    entryId: entryId,
                    table: dataSourceName,
                    fileIdsColumn: resolvedColumnName
                }).then(result => {
                    // Clear uploading state for this file
                    if (clearUploadingFile) {
                        clearUploadingFile(dataSourceName, entryId, tempFileId);
                    }
                    return result;
                }).catch(error => {
                    // Clear uploading state on error
                    if (clearUploadingFile) {
                        clearUploadingFile(dataSourceName, entryId, tempFileId);
                    }
                    throw error;
                });
            });

            const results = await Promise.all(uploadPromises);

            // Computed files arrays update automatically when the bucket array changes.
            return files.length === 1 ? results[0] : results;
        } catch (error) {
            // Clear all uploading states on error
            if (clearUploadingFile) {
                fileIds.forEach(fileId => {
                    clearUploadingFile(dataSourceName, entryId, fileId);
                });
            }
            throw error;
        }
    };
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxiesMagic) {
    window.ManifestDataProxiesMagic = {};
}
window.ManifestDataProxiesMagic.createUploadMethod = createUploadMethod;

