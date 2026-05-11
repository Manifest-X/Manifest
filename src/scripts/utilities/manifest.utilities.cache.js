// Cache management
// Methods for loading, saving, and managing cached utilities

// Load and apply cached utilities
TailwindCompiler.prototype.loadAndApplyCache = function () {
    const cacheStart = performance.now();
    try {
        const cached = localStorage.getItem('tailwind-cache');
        if (cached) {
            const parsed = JSON.parse(cached);
            this.cache = new Map(Object.entries(parsed));

            // Try to find the best matching cache entry
            // First, try to get a quick scan of current classes
            let currentClasses = new Set();
            try {
                // Quick scan of HTML source for classes
                if (document.documentElement) {
                    const htmlSource = document.documentElement.outerHTML;
                    const classRegex = /class=["']([^"']+)["']/gi;
                    let classMatch;
                    while ((classMatch = classRegex.exec(htmlSource)) !== null) {
                        const classes = classMatch[1].split(/\s+/).filter(Boolean);
                        classes.forEach(cls => {
                            if (!cls.startsWith('x-') && !cls.startsWith('$')) {
                                currentClasses.add(cls);
                            }
                        });
                    }
                }
            } catch (e) {
                // If HTML parsing fails, just use most recent
            }

            let bestMatch = null;
            let bestScore = 0;

            // Score cache entries by how many classes they match
            if (currentClasses.size > 0) {
                for (const [key, value] of this.cache.entries()) {
                    // Extract classes from cache key (format: "class1,class2-themeHash")
                    // Find the last occurrence of '-' followed by 8 chars (theme hash length)
                    const lastDashIndex = key.lastIndexOf('-');
                    const classesPart = lastDashIndex > 0 ? key.substring(0, lastDashIndex) : key;
                    const cachedClasses = classesPart ? classesPart.split(',') : [];
                    const cachedSet = new Set(cachedClasses);

                    // Count how many current classes are in cache
                    let matches = 0;
                    for (const cls of currentClasses) {
                        if (cachedSet.has(cls)) {
                            matches++;
                        }
                    }

                    // Score based on match ratio and recency
                    const matchRatio = matches / currentClasses.size;
                    const recencyScore = (Date.now() - value.timestamp) / (24 * 60 * 60 * 1000); // Days since cache
                    const score = matchRatio * 0.7 + (1 - Math.min(recencyScore, 1)) * 0.3; // 70% match, 30% recency

                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = value;
                    }
                }
            }

            // Use best match, or fall back to most recent
            const cacheToUse = bestMatch || Array.from(this.cache.entries())
                .sort((a, b) => b[1].timestamp - a[1].timestamp)[0]?.[1];

            if (cacheToUse && cacheToUse.css) {
                const applyCacheStart = performance.now();
                this.styleElement.textContent = cacheToUse.css;
                this.ensureUtilityStylesLast();
                this.scheduleEnsureUtilityStylesLast();
                this.lastThemeHash = cacheToUse.themeHash;

                // Also apply cache to critical style element
                // Extract utilities from @layer utilities block and apply directly (no @layer)
                if (this.criticalStyleElement && !this.criticalStyleElement.textContent) {
                    let criticalCss = cacheToUse.css;
                    // Remove @layer utilities wrapper if present
                    criticalCss = criticalCss.replace(/@layer\s+utilities\s*\{/g, '').replace(/\}\s*$/, '').trim();
                    if (criticalCss) {
                        this.criticalStyleElement.textContent = criticalCss;
                    }
                }

                // Don't clear critical styles yet - keep them until full compilation completes
            }
        }
    } catch (error) {
        // Silently fail - cache is optional
    }
};

// Cap on persisted cache entries.  Each entry stores a full compiled
// stylesheet keyed by the union of classes seen on a given page, so on a
// multi-page MPA this Map grows fast — and localStorage tops out at ~5MB per
// origin.  20 covers typical hot paths; rarer routes recompile (cheap).
TailwindCompiler.prototype.MAX_PERSISTED_CACHE_ENTRIES = 20;

// Drop the oldest entries from this.cache until at most `limit` remain.
// Uses entry.timestamp; entries without one are evicted first.
TailwindCompiler.prototype.evictOldestCacheEntries = function (limit) {
    if (this.cache.size <= limit) return;
    const sorted = Array.from(this.cache.entries())
        .sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
    const toRemove = sorted.length - limit;
    for (let i = 0; i < toRemove; i++) {
        this.cache.delete(sorted[i][0]);
    }
};

// Save cache to localStorage with size cap and quota-aware eviction.
TailwindCompiler.prototype.savePersistentCache = function () {
    // Proactive cap so we don't write something we know is at risk.
    this.evictOldestCacheEntries(this.MAX_PERSISTED_CACHE_ENTRIES);
    let attempts = 0;
    while (this.cache.size > 0 && attempts < 4) {
        try {
            const serialized = JSON.stringify(Object.fromEntries(this.cache));
            localStorage.setItem('tailwind-cache', serialized);
            return;
        } catch (error) {
            // QuotaExceededError (name varies by browser): drop the oldest
            // half and retry.  Anything else: bail.
            const isQuotaError =
                error && (
                    error.name === 'QuotaExceededError' ||
                    error.code === 22 ||
                    error.code === 1014 // Firefox: NS_ERROR_DOM_QUOTA_REACHED
                );
            if (!isQuotaError) {
                console.warn('Failed to save cached styles:', error);
                return;
            }
            const halved = Math.max(1, Math.floor(this.cache.size / 2));
            this.evictOldestCacheEntries(halved);
            attempts++;
        }
    }
    // Last resort: cache is unusable in this origin right now, clear the slot
    // so the next session starts clean.  This is a perf optimization, not
    // correctness — drop quietly.
    try { localStorage.removeItem('tailwind-cache'); } catch (_) {}
};

// Load cache from localStorage
TailwindCompiler.prototype.loadPersistentCache = function () {
    try {
        const cached = localStorage.getItem('tailwind-cache');
        if (cached) {
            const parsed = JSON.parse(cached);
            this.cache = new Map(Object.entries(parsed));
        }
    } catch (error) {
        console.warn('Failed to load cached styles:', error);
    }
};

// Generate a hash of the theme variables to detect changes
TailwindCompiler.prototype.generateThemeHash = function (themeCss) {
    // Use encodeURIComponent to handle non-Latin1 characters safely
    return encodeURIComponent(themeCss).slice(0, 8); // Simple hash of theme content
};

// Clean up old cache entries
TailwindCompiler.prototype.cleanupCache = function () {
    const now = Date.now();
    const maxAge = this.options.maxCacheAge;
    const entriesToDelete = [];

    for (const [key, value] of this.cache.entries()) {
        if (value.timestamp && (now - value.timestamp > maxAge)) {
            entriesToDelete.push(key);
        }
    }

    for (const key of entriesToDelete) {
        this.cache.delete(key);
    }

    if (entriesToDelete.length > 0) {
        this.savePersistentCache();
    }
};

