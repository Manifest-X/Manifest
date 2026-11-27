// Components mutation observer
// Deferred placeholders are left for swapping's post-router pass.
window.ManifestComponentsMutation = {
    async processAllPlaceholders() {
        const processor = window.ManifestComponentsProcessor;
        const gate = window.ManifestComponentsRouting;
        if (!processor) return;
        const placeholders = Array.from(document.querySelectorAll('*')).filter(el =>
            el.tagName.toLowerCase().startsWith('x-') &&
            !el.hasAttribute('data-pre-rendered') &&
            !el.hasAttribute('data-processed')
        );
        const decide = gate.gate();
        for (const el of placeholders) {
            if (decide(el) !== 'swap') continue;
            await processor.processComponent(el);
        }
    },
    initialize() {
        const processor = window.ManifestComponentsProcessor;
        const gate = window.ManifestComponentsRouting;
        if (!processor) return;
        // Initial scan: swapping's boot pass covers it when present
        if (!window.ManifestComponentsSwapping) this.processAllPlaceholders();
        const isPlaceholder = el => el.tagName.toLowerCase().startsWith('x-') &&
            !el.hasAttribute('data-pre-rendered') && !el.hasAttribute('data-processed');
        // Mutation observer for new placeholders
        const observer = new MutationObserver(async mutations => {
            const decide = gate.gate();
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (isPlaceholder(node) && decide(node) === 'swap') {
                        await processor.processComponent(node);
                    }
                    // Also check for any <x-*> descendants
                    const descendants = Array.from(node.querySelectorAll('*')).filter(isPlaceholder);
                    for (const el of descendants) {
                        if (decide(el) !== 'swap') continue;
                        await processor.processComponent(el);
                    }
                }
            }
        });

        // Ensure document.body exists before observing
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        } else {
            // Wait for body to be available
            document.addEventListener('DOMContentLoaded', () => {
                observer.observe(document.body, { childList: true, subtree: true });
            });
        }
    }
};
