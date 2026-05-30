// Router position

// Assign data-order attributes to all top-level elements
function assignDataPositions() {
    if (!document.body) return;

    const bodyChildren = Array.from(document.body.children);

    bodyChildren.forEach((element, index) => {
        element.setAttribute('data-order', index.toString());
    });
}

// Initialize position management
function initializePositionManagement() {
    assignDataPositions();
}

// Run immediately if DOM is ready, otherwise wait
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePositionManagement);
} else {
    initializePositionManagement();
}

// Export position management interface
window.ManifestRoutingPosition = {
    initialize: initializePositionManagement,
    assignDataPositions
}; 