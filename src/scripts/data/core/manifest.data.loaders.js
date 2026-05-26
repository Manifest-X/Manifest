/* Manifest Data Sources - File Loaders */

// Key names that would walk into Object's prototype chain if used as nested-
// path segments. Rejecting them in setNestedValue and deepMergeWithFallback
// prevents a CSV row like `__proto__.polluted, true` (or a malicious JSON
// locale file containing `{"__proto__": {...}}`) from polluting
// Object.prototype and silently affecting every plain object on the page.
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Dynamic js-yaml loader
let jsyaml = null;
let yamlLoadingPromise = null;

// Dynamic PapaParse CSV loader
let papaparse = null;
let csvLoadingPromise = null;

// Collect all path-like strings from manifest.data (recursive; includes nested locale objects)
function collectDataPaths(manifest) {
    const paths = [];
    if (!manifest?.data || typeof manifest.data !== 'object') return paths;
    function visit(val) {
        if (typeof val === 'string' && (val.startsWith('/') || /\.(yaml|yml|csv|json)$/i.test(val))) {
            paths.push(val);
        } else if (Array.isArray(val)) {
            val.forEach(visit);
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            Object.values(val).forEach(visit);
        }
    }
    Object.values(manifest.data).forEach(visit);
    return paths;
}

function manifestDataPathsInclude(manifest, extensions) {
    const paths = collectDataPaths(manifest);
    return paths.some(p => extensions.some(ext => p.toLowerCase().includes(ext)));
}

async function loadYamlLibrary() {
    if (jsyaml) return jsyaml;
    if (yamlLoadingPromise) return yamlLoadingPromise;

    const manifest = await window.ManifestDataConfig?.ensureManifest?.();
    if (manifest && !manifestDataPathsInclude(manifest, ['.yaml', '.yml'])) {
        yamlLoadingPromise = Promise.reject(new Error('[Manifest Data] No YAML paths in manifest - skipping loader'));
        return yamlLoadingPromise;
    }

    yamlLoadingPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/js-yaml/dist/js-yaml.min.js';
        script.onload = () => {
            if (typeof window.jsyaml !== 'undefined') {
                jsyaml = window.jsyaml;
                resolve(jsyaml);
            } else {
                console.error('[Manifest Data] js-yaml failed to load - jsyaml is undefined');
                yamlLoadingPromise = null; // Reset so we can try again
                reject(new Error('js-yaml failed to load'));
            }
        };
        script.onerror = (error) => {
            console.error('[Manifest Data] Script failed to load:', error);
            yamlLoadingPromise = null; // Reset so we can try again
            reject(error);
        };
        document.head.appendChild(script);
    });

    return yamlLoadingPromise;
}

// Dynamic PapaParse CSV loader
async function loadCSVParser() {
    if (papaparse) return papaparse;
    if (csvLoadingPromise) return csvLoadingPromise;

    const manifest = await window.ManifestDataConfig?.ensureManifest?.();
    if (manifest && !manifestDataPathsInclude(manifest, ['.csv'])) {
        csvLoadingPromise = Promise.reject(new Error('[Manifest Data] No CSV paths in manifest - skipping loader'));
        return csvLoadingPromise;
    }

    csvLoadingPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/papaparse@latest/papaparse.min.js';
        script.onload = () => {
            if (typeof window.Papa !== 'undefined') {
                papaparse = window.Papa;
                resolve(papaparse);
            } else {
                console.error('[Manifest Data] PapaParse failed to load - Papa is undefined');
                csvLoadingPromise = null; // Reset so we can try again
                reject(new Error('PapaParse failed to load'));
            }
        };
        script.onerror = (error) => {
            console.error('[Manifest Data] CSV parser script failed to load:', error);
            csvLoadingPromise = null; // Reset so we can try again
            reject(error);
        };
        document.head.appendChild(script);
    });

    return csvLoadingPromise;
}

// Deep merge objects with current locale taking precedence
function deepMergeWithFallback(currentData, fallbackData) {
    if (fallbackData === null || fallbackData === undefined) {
        return currentData;
    }
    if (currentData === null || currentData === undefined) {
        return fallbackData;
    }

    // If both are arrays, merge array items by index
    if (Array.isArray(currentData) && Array.isArray(fallbackData)) {
        const maxLength = Math.max(currentData.length, fallbackData.length);
        const merged = [];
        for (let i = 0; i < maxLength; i++) {
            const currentItem = currentData[i];
            const fallbackItem = fallbackData[i];
            if (currentItem !== undefined && fallbackItem !== undefined) {
                // Both exist - merge recursively
                merged.push(deepMergeWithFallback(currentItem, fallbackItem));
            } else if (currentItem !== undefined) {
                // Only current exists
                merged.push(currentItem);
            } else {
                // Only fallback exists
                merged.push(fallbackItem);
            }
        }
        return merged;
    }

    // If both are objects, merge recursively
    if (typeof currentData === 'object' && typeof fallbackData === 'object' &&
        !Array.isArray(currentData) && !Array.isArray(fallbackData)) {
        const merged = { ...fallbackData };
        for (const key in currentData) {
            if (POLLUTING_KEYS.has(key)) continue;
            if (key.startsWith('_')) {
                // Preserve metadata from current locale
                merged[key] = currentData[key];
            } else {
                const currentValue = currentData[key];
                // Treat empty strings as missing values (fallback to default locale)
                if (currentValue !== undefined && currentValue !== null && currentValue !== '') {
                    // Recursively merge nested objects/arrays
                    merged[key] = deepMergeWithFallback(currentValue, fallbackData[key]);
                }
                // If current value is empty/missing, keep fallback value (already in merged)
            }
        }
        return merged;
    }

    // For primitives or mismatched types, prefer current (but treat empty strings as missing)
    if (currentData !== undefined && currentData !== null && currentData !== '') {
        return currentData;
    }
    return fallbackData;
}

// Set nested value in object using dot notation path.
// Numeric path segments (e.g. cards.0.title) create real arrays so x-for="card in $x....cards" works.
function setNestedValue(obj, path, value) {
    const keys = path.split('.');
    // Drop the whole row if any segment would walk into the prototype chain.
    // `foo.constructor.prototype.polluted` is just as dangerous as `__proto__.polluted`.
    if (keys.some(k => POLLUTING_KEYS.has(k))) return;
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        const nextKey = keys[i + 1];
        const nextIsIndex = /^\d+$/.test(nextKey);

        if (!(key in current)) {
            current[key] = nextIsIndex ? [] : {};
        } else if (nextIsIndex && !Array.isArray(current[key]) && current[key] && typeof current[key] === 'object') {
            // If we later discover this container should be an array, coerce numeric-key objects.
            const existing = current[key];
            const existingKeys = Object.keys(existing);
            const numericOnly = existingKeys.every(k => /^\d+$/.test(k));
            if (numericOnly) {
                const arr = [];
                existingKeys.forEach(k => {
                    arr[parseInt(k, 10)] = existing[k];
                });
                current[key] = arr;
            }
        }

        if (Array.isArray(current) && /^\d+$/.test(key)) {
            const idx = parseInt(key, 10);
            if (current[idx] == null || typeof current[idx] !== 'object') {
                current[idx] = nextIsIndex ? [] : {};
            }
        }

        current = current[key];
    }

    current[keys[keys.length - 1]] = value;
}

// If the key-value result has only numeric top-level keys (e.g. 0.path, 1.path), convert to array
// so $route/$search/$query work and the shape matches YAML/JSON array sources.
function numericKeyObjectToArray(obj) {
    if (obj == null || Array.isArray(obj) || typeof obj !== 'object') {
        return obj;
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) return obj;
    const numericKeys = keys.filter(k => /^\d+$/.test(k));
    if (numericKeys.length !== keys.length) return obj;
    const sorted = numericKeys.map(k => parseInt(k, 10)).sort((a, b) => a - b);
    return sorted.map(i => obj[String(i)]);
}

// Parse CSV text to nested object structure
function parseCSVToNestedObject(csvText, options = {}) {
    const {
        currentLocale = null,
        delimiter = ','
    } = options;

    // Use PapaParse if available, otherwise fall back to simple parser
    if (papaparse) {
        const parsed = papaparse.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            delimiter: delimiter
        });

        if (parsed.errors && parsed.errors.length > 0) {
            const serious = parsed.errors.filter(e => e.code !== 'TooFewFields');
            if (serious.length > 0) {
                console.warn('[Manifest Data] CSV parsing warnings:', serious);
            }
        }

        if (!parsed.data || parsed.data.length === 0) {
            throw new Error('[Manifest Data] CSV file is empty or has no data rows');
        }

        const result = {};
        const headers = Object.keys(parsed.data[0] || {});

        if (headers.length === 0) {
            throw new Error('[Manifest Data] CSV file has no headers');
        }

        // First column is always the key
        const keyColumn = headers[0];

        // Detect if this is tabular data (array of objects) vs key-value data (nested object)
        // Tabular: first column header is "id" (case-insensitive) AND 3+ columns AND values look like IDs
        // Key-value: everything else (supports both flat keys like "home" and dot notation like "home.title")
        const keyColumnLower = keyColumn.toLowerCase();
        let isTabular = false;

        if (headers.length > 2 && keyColumnLower === 'id') {
            // Check if first column values look like IDs (numeric or short identifiers)
            const sampleRows = parsed.data.slice(0, Math.min(5, parsed.data.length));
            const idLikeRows = sampleRows.filter(row => {
                const val = row[keyColumn];
                return val && (/^\d+$/.test(val) || (val.length < 20 && !val.includes('.')));
            });
            // If most sample rows look like IDs, treat as tabular
            isTabular = idLikeRows.length >= sampleRows.length * 0.6;
        }

        if (isTabular) {
            // Return array of objects (tabular data like product inventory)
            const array = [];
            for (const row of parsed.data) {
                if (!row || Object.keys(row).length === 0) continue;
                // Create object from all columns
                const obj = {};
                for (const header of headers) {
                    obj[header] = row[header];
                }
                array.push(obj);
            }
            return array;
        } else {
            // Key-value mode: convert dot notation to nested object
            // Auto-detect value column:
            // 1. If currentLocale is provided and matches a header, use that
            // 2. Otherwise, use the second column (or first non-key column)
            let valueColumnName = null;
            let fallbackColumnName = null; // First locale column (default fallback)

            if (currentLocale && headers.includes(currentLocale)) {
                valueColumnName = currentLocale;
            } else if (headers.length > 1) {
                // Use second column (first non-key column)
                valueColumnName = headers[1];
            } else {
                throw new Error('[Manifest Data] CSV file must have at least two columns (key and value)');
            }

            // Find first locale column (first column after 'key') as fallback
            if (headers.length > 1) {
                fallbackColumnName = headers[1];
            }

            for (const row of parsed.data) {
                if (!row || Object.keys(row).length === 0) continue;

                const key = row[keyColumn];
                if (!key) continue;

                // Get value from the detected value column
                let value = row[valueColumnName];

                // If value is empty/missing and we have a fallback column, use it
                if ((value === undefined || value === null || value === '') && fallbackColumnName && fallbackColumnName !== valueColumnName) {
                    value = row[fallbackColumnName];
                }

                // Convert dot notation to nested object
                setNestedValue(result, key, value);
            }

            return numericKeyObjectToArray(result);
        }
    } else {
        // Fallback simple parser (if PapaParse not loaded)
        const lines = csvText.split('\n').filter(line => line.trim());
        if (lines.length < 2) {
            throw new Error('[Manifest Data] CSV file must have at least a header row and one data row');
        }

        // Simple CSV line parser (handles quoted values)
        function parseCSVLine(line, delim) {
            const result = [];
            let current = '';
            let inQuotes = false;

            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === delim && !inQuotes) {
                    result.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            result.push(current.trim());
            return result;
        }

        const headers = parseCSVLine(lines[0], delimiter);
        if (headers.length < 2) {
            throw new Error('[Manifest Data] CSV file must have at least two columns');
        }

        // First column is always the key
        const keyColumn = headers[0];

        // Detect if this is tabular data (array of objects) vs key-value data (nested object)
        // Tabular: first column header is "id" (case-insensitive) AND 3+ columns AND values look like IDs
        // Key-value: everything else (supports both flat keys like "home" and dot notation like "home.title")
        const keyColumnLower = keyColumn.toLowerCase();
        let isTabular = false;

        if (headers.length > 2 && keyColumnLower === 'id') {
            // Check if first column values look like IDs (numeric or short identifiers)
            let idLikeCount = 0;
            const sampleSize = Math.min(5, lines.length - 1);
            for (let i = 1; i <= sampleSize; i++) {
                const values = parseCSVLine(lines[i], delimiter);
                const val = values[0];
                if (val && (/^\d+$/.test(val) || (val.length < 20 && !val.includes('.')))) {
                    idLikeCount++;
                }
            }
            // If most sample rows look like IDs, treat as tabular
            isTabular = idLikeCount >= sampleSize * 0.6;
        }

        if (isTabular) {
            // Return array of objects (tabular data like product inventory)
            const array = [];
            for (let i = 1; i < lines.length; i++) {
                const values = parseCSVLine(lines[i], delimiter);
                if (values.length === 0) continue;

                const obj = {};
                for (let j = 0; j < headers.length; j++) {
                    obj[headers[j]] = values[j] !== undefined ? values[j] : null;
                }
                array.push(obj);
            }
            return array;
        } else {
            // Key-value mode: convert dot notation to nested object
            // Auto-detect value column: use current locale if available, otherwise second column
            let valueColumnName = null;
            let fallbackColumnName = null; // First locale column (default fallback)

            if (currentLocale && headers.includes(currentLocale)) {
                valueColumnName = currentLocale;
            } else {
                valueColumnName = headers[1];
            }

            // Find first locale column (first column after 'key') as fallback
            if (headers.length > 1) {
                fallbackColumnName = headers[1];
            }

            const keyIndex = 0;
            const valueIndex = headers.indexOf(valueColumnName);
            const fallbackIndex = fallbackColumnName ? headers.indexOf(fallbackColumnName) : -1;

            const result = {};

            for (let i = 1; i < lines.length; i++) {
                const values = parseCSVLine(lines[i], delimiter);
                const key = values[keyIndex];
                if (!key) continue;

                let value = values[valueIndex] !== undefined ? values[valueIndex] : null;

                // If value is empty/missing and we have a fallback column, use it
                if ((value === undefined || value === null || value === '') && fallbackIndex >= 0 && fallbackIndex !== valueIndex) {
                    value = values[fallbackIndex] !== undefined ? values[fallbackIndex] : null;
                }

                // Convert dot notation to nested object
                setNestedValue(result, key, value);
            }

            return numericKeyObjectToArray(result);
        }
    }
}

// Load a local file (JSON, YAML, CSV). Resolves manifest-relative paths when viewing from dist.
function resolveDataPath(filePath) {
    if (!filePath || typeof filePath !== 'string' || filePath.startsWith('http')) {
        return filePath;
    }
    const base = typeof window.getManifestBase === 'function' ? window.getManifestBase() : '';
    const pathOnly = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    return base ? base + pathOnly : filePath;
}

// Load a local file (JSON, YAML, CSV)
async function loadLocalFile(filePath, options = {}) {
    const resolved = resolveDataPath(filePath);
    const response = await fetch(resolved);

    // Check if file exists
    if (!response.ok) {
        throw new Error(`[Manifest Data] File not found: ${resolved} (${response.status})`);
    }

    const contentType = response.headers.get('content-type');

    // Handle CSV files
    if (resolved.endsWith('.csv') || contentType?.includes('text/csv')) {
        const text = await response.text();
        const csvParser = await loadCSVParser();
        // Pass currentLocale if provided in options
        return parseCSVToNestedObject(text, { currentLocale: options.currentLocale });
    }
    // Handle JSON files
    else if (contentType?.includes('application/json') || resolved.endsWith('.json')) {
        return await response.json();
    }
    // Handle YAML files
    else if (contentType?.includes('text/yaml') || resolved.endsWith('.yaml') || resolved.endsWith('.yml')) {
        const text = await response.text();
        const yamlLib = await loadYamlLibrary();
        return yamlLib.load(text);
    } else {
        // Try JSON first, then YAML, then CSV
        try {
            const text = await response.text();
            return JSON.parse(text);
        } catch (e) {
            try {
                const yamlLib = await loadYamlLibrary();
                return yamlLib.load(text);
            } catch (e2) {
                // Last resort: try CSV
                const csvParser = await loadCSVParser();
                return parseCSVToNestedObject(text, { currentLocale: options.currentLocale });
            }
        }
    }
}

// Export functions to window for use by other subscripts
window.ManifestDataLoaders = {
    loadYamlLibrary,
    loadCSVParser,
    deepMergeWithFallback,
    parseCSVToNestedObject,
    setNestedValue,
    numericKeyObjectToArray,
    resolveDataPath,
    loadLocalFile
};