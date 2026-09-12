// Components swapping
(function () {
    // Never reset — ids must stay unique for the life of the page so overlapping
    // processAll runs can't mint a colliding id for a live instance.
    let componentInstanceCounters = {};
    const swappedInstances = new Set();
    const instanceRouteMap = new Map();
    const placeholderMap = new Map();

    // Serialises processAll: a call while one is in flight coalesces into a
    // single trailing re-run (latest path wins) instead of interleaving.
    let activeRun = null;
    let trailingRun = null;
    let trailingPath = null;
    let hasTrailing = false;
    let trailingSettlers = null;

    function getComponentInstanceId(name) {
        if (!componentInstanceCounters[name]) componentInstanceCounters[name] = 1;
        else componentInstanceCounters[name]++;
        return `${name}-${componentInstanceCounters[name]}`;
    }

    function logSiblings(parent, context) {
        if (!parent) return;
        const siblings = Array.from(parent.children).map(el => `${el.tagName}[data-component=${el.getAttribute('data-component') || ''}]`).join(', ');
    }

    window.ManifestComponentsSwapping = {
        // Swap in source code for a placeholder
        async swapIn(placeholder) {
            if (placeholder.hasAttribute('data-swapped')) {
                console.debug('[Manifest Components] skipped swapIn: already marked data-swapped', placeholder);
                return;
            }
            const processor = window.ManifestComponentsProcessor;
            if (!processor) {
                console.debug('[Manifest Components] skipped swapIn: processor unavailable', placeholder);
                return;
            }
            const name = placeholder.tagName.toLowerCase().replace('x-', '');
            let instanceId = placeholder.getAttribute('data-component');
            if (!instanceId) {
                instanceId = getComponentInstanceId(name);
                placeholder.setAttribute('data-component', instanceId);
            }
            // Save placeholder for reversion in the map
            if (!placeholderMap.has(instanceId)) {
                const clone = placeholder.cloneNode(true);
                clone.setAttribute('data-original-placeholder', '');
                clone.setAttribute('data-component', instanceId);
                placeholderMap.set(instanceId, clone);
            }
            // Log before swap
            logSiblings(placeholder.parentNode, `Before swapIn for ${instanceId}`);
            // Process and swap in source code, passing instanceId
            await processor.processComponent(placeholder, instanceId);
            swappedInstances.add(instanceId);
            // Track the route for this instance
            const xRoute = placeholder.getAttribute('x-route');
            instanceRouteMap.set(instanceId, xRoute);
            // Log after swap
            logSiblings(placeholder.parentNode || document.body, `After swapIn for ${instanceId}`);
        },
        // Revert to placeholder
        revert(instanceId) {
            if (!swappedInstances.has(instanceId)) {
                console.debug('[Manifest Components] skipped revert: instance not tracked', instanceId);
                return;
            }
            // Remove all elements with data-component=instanceId
            const rendered = Array.from(document.querySelectorAll(`[data-component="${instanceId}"]`));
            if (rendered.length === 0) {
                console.debug('[Manifest Components] skipped revert: no rendered elements found', instanceId);
                return;
            }
            const first = rendered[0];
            const parent = first.parentNode;
            // Retrieve the original placeholder from the map
            const placeholder = placeholderMap.get(instanceId);
            // Log before revert
            logSiblings(parent, `Before revert for ${instanceId}`);
            // Remove all rendered elements
            rendered.forEach(el => {
                el.remove();
            });
            // Restore the placeholder at the correct position if not present
            if (placeholder && parent && !parent.contains(placeholder)) {
                const targetPosition = parseInt(placeholder.getAttribute('data-order')) || 0;
                let inserted = false;

                // Find the correct position based on data-order
                for (let i = 0; i < parent.children.length; i++) {
                    const child = parent.children[i];
                    const childPosition = parseInt(child.getAttribute('data-order')) || 0;

                    if (targetPosition < childPosition) {
                        parent.insertBefore(placeholder, child);
                        inserted = true;
                        break;
                    }
                }

                // If not inserted (should be at the end), append to parent
                if (!inserted) {
                    parent.appendChild(placeholder);
                }

            }
            swappedInstances.delete(instanceId);
            instanceRouteMap.delete(instanceId);
            placeholderMap.delete(instanceId);
            // Log after revert
            logSiblings(parent, `After revert for ${instanceId}`);
        },
        // Main swapping logic — single pass. Call via processAll(), not directly:
        // this has no re-entrancy guard of its own.
        async _runProcessAll(normalizedPathFromEvent) {
            const registry = window.ManifestComponentsRegistry;
            if (!registry) {
                console.debug('[Manifest Components] skipped processAll: registry unavailable');
                return;
            }
            const routing = window.ManifestRouting;

            // Use normalized path from event if provided, otherwise compute from window.location
            let normalizedPath;
            if (normalizedPathFromEvent !== null) {
                normalizedPath = normalizedPathFromEvent;
            } else {
                const currentPath = window.location.pathname;
                normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');
            }

            const placeholders = Array.from(document.querySelectorAll('*')).filter(el =>
                el.tagName.toLowerCase().startsWith('x-') &&
                !el.hasAttribute('data-pre-rendered') &&
                !el.hasAttribute('data-processed')
            );
            // First pass: revert any swapped-in instances that no longer match
            if (routing) {
                for (const instanceId of Array.from(swappedInstances)) {
                    const xRoute = instanceRouteMap.get(instanceId);
                    if (!xRoute) {
                        // No route condition means always visible, don't revert
                        continue;
                    }
                    // Parse route conditions the same way as route visibility
                    const conditions = xRoute.split(',').map(cond => cond.trim());
                    const positiveConditions = conditions.filter(cond => !cond.startsWith('!'));
                    const negativeConditions = conditions
                        .filter(cond => cond.startsWith('!'))
                        .map(cond => cond.slice(1));

                    const hasNegativeMatch = negativeConditions.some(cond =>
                        window.ManifestRouting.matchesCondition(normalizedPath, cond)
                    );
                    const hasPositiveMatch = positiveConditions.length === 0 || positiveConditions.some(cond =>
                        window.ManifestRouting.matchesCondition(normalizedPath, cond)
                    );

                    const matches = hasPositiveMatch && !hasNegativeMatch;
                    if (!matches) {
                        this.revert(instanceId);
                    }
                }
            }
            // Second pass: swap in any placeholders that match
            for (const placeholder of placeholders) {
                const name = placeholder.tagName.toLowerCase().replace('x-', '');
                let instanceId = placeholder.getAttribute('data-component');
                if (!instanceId) {
                    instanceId = getComponentInstanceId(name);
                    placeholder.setAttribute('data-component', instanceId);
                }
                const xRoute = placeholder.getAttribute('x-route');
                if (!routing) {
                    // No routing: always swap in
                    await this.swapIn(placeholder);
                } else {
                    // Routing present: check route using same logic as route visibility
                    // Handle comma-separated route conditions (e.g., "/,page-1,page-2")
                    let matches = !xRoute;
                    if (xRoute) {
                        const conditions = xRoute.split(',').map(cond => cond.trim());
                        const positiveConditions = conditions.filter(cond => !cond.startsWith('!'));
                        const negativeConditions = conditions
                            .filter(cond => cond.startsWith('!'))
                            .map(cond => cond.slice(1));

                        // Check negative conditions first
                        const hasNegativeMatch = negativeConditions.some(cond =>
                            window.ManifestRouting.matchesCondition(normalizedPath, cond)
                        );

                        // Check positive conditions
                        const hasPositiveMatch = positiveConditions.length === 0 || positiveConditions.some(cond =>
                            window.ManifestRouting.matchesCondition(normalizedPath, cond)
                        );

                        matches = hasPositiveMatch && !hasNegativeMatch;
                    }

                    if (matches) {
                        await this.swapIn(placeholder);
                    }
                }
            }
        },
        // Public entry point. Coalesces overlapping calls: while a run is active,
        // later calls don't start their own interleaved run — they queue exactly
        // one trailing re-run (latest path wins) and resolve when it finishes.
        async processAll(normalizedPathFromEvent = null) {
            if (activeRun) {
                hasTrailing = true;
                trailingPath = normalizedPathFromEvent;
                if (!trailingRun) {
                    trailingRun = new Promise((resolve, reject) => {
                        trailingSettlers = { resolve, reject };
                    });
                }
                return trailingRun;
            }
            activeRun = this._runProcessAll(normalizedPathFromEvent);
            let error = null;
            try {
                await activeRun;
            } catch (e) {
                error = e;
            } finally {
                activeRun = null;
            }
            if (hasTrailing) {
                hasTrailing = false;
                const path = trailingPath;
                const settlers = trailingSettlers;
                trailingRun = null;
                trailingSettlers = null;
                trailingPath = null;
                this.processAll(path).then(settlers.resolve, settlers.reject);
            }
            if (error) throw error;
        },
        initialize() {
            // On init, process all
            this.processAll().then(() => {
                // Dispatch event when components are fully processed
                window.dispatchEvent(new CustomEvent('manifest:components-processed'));
            });
            // If routing is present, listen for route changes
            if (window.ManifestRouting) {
                window.addEventListener('manifest:route-change', (event) => {
                    // Use normalized path from event detail if available
                    const normalizedPath = event.detail?.normalizedPath || null;
                    this.processAll(normalizedPath).then(() => {
                        // Dispatch event when components are fully processed after route change
                        window.dispatchEvent(new CustomEvent('manifest:components-processed'));
                    });
                });
            }
        }
    };
})(); 