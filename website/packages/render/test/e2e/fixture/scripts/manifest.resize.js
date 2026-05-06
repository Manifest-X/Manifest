/* Manifest Resizer */

function initializeResizablePlugin() {
    // Cache for unit conversions to avoid repeated DOM manipulation
    const unitCache = new Map();
    let tempConversionEl = null;

    // Helper to parse value and unit from CSS dimension
    const parseDimension = (value) => {
        if (typeof value === 'number') return { value, unit: 'px' };
        const match = String(value).match(/^([\d.]+)(.*)$/);
        return match ? { value: parseFloat(match[1]), unit: match[2] || 'px' } : { value: 0, unit: 'px' };
    };

    // Helper to convert any unit to pixels (cached and optimized)
    const convertToPixels = (value, unit) => {
        if (unit === 'px') return value;

        const cacheKey = `${value}${unit}`;
        if (unitCache.has(cacheKey)) {
            return unitCache.get(cacheKey);
        }

        // Use a single cached conversion element
        if (!tempConversionEl) {
            tempConversionEl = document.createElement('div');
            tempConversionEl.style.cssText = 'visibility:hidden;position:absolute;top:-9999px;left:-9999px;width:0;height:0;';
            document.body.appendChild(tempConversionEl);
        }

        tempConversionEl.style.width = `${value}${unit}`;
        const pixels = tempConversionEl.getBoundingClientRect().width;

        unitCache.set(cacheKey, pixels);
        return pixels;
    };

    // Helper to convert pixels back to original unit (cached)
    const convertFromPixels = (pixels, unit, element) => {
        if (unit === 'px') return pixels;

        const cacheKey = `${pixels}${unit}${element.tagName}`;
        if (unitCache.has(cacheKey)) {
            return unitCache.get(cacheKey);
        }

        let result;
        switch (unit) {
            case '%':
                result = (pixels / element.parentElement.getBoundingClientRect().width) * 100;
                break;
            case 'rem':
                const remSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
                result = pixels / remSize;
                break;
            case 'em':
                const emSize = parseFloat(getComputedStyle(element).fontSize);
                result = pixels / emSize;
                break;
            default:
                result = pixels;
        }

        unitCache.set(cacheKey, result);
        return result;
    };

    Alpine.directive('resize', (el, { modifiers, expression }, { evaluate }) => {
        // Store configuration on the element for lazy initialization
        el._resizeConfig = {
            expression,
            evaluate,
            handles: null,
            initialized: false
        };

        // Load saved width and height immediately if specified
        if (expression) {
            try {
                const options = evaluate(expression);
                if (options) {
                    if (options.saveWidth) {
                        const savedWidth = localStorage.getItem(`resizable-${options.saveWidth}`);
                        if (savedWidth) {
                            // Preserve the original unit if saved
                            const [value, unit] = savedWidth.split('|');
                            el.style.width = `${value}${unit || 'px'}`;
                        }
                    }
                    if (options.saveHeight) {
                        const savedHeight = localStorage.getItem(`resizable-${options.saveHeight}`);
                        if (savedHeight) {
                            // Preserve the original unit if saved
                            const [value, unit] = savedHeight.split('|');
                            el.style.height = `${value}${unit || 'px'}`;
                        }
                    }
                }
            } catch (error) {
                // Ignore parsing errors here, they'll be handled in initializeResizeElement
            }
        }

        // Add hover listener to create handles on first interaction
        el.addEventListener('mouseenter', initializeResizeElement, { once: true });
    });

    function initializeResizeElement(event) {
        const el = event.target;
        const config = el._resizeConfig;
        if (config.initialized) return;

        config.initialized = true;

        // Helper to parse value and unit from CSS dimension
        const parseDimension = (value) => {
            if (typeof value === 'number') return { value, unit: 'px' };
            const match = String(value).match(/^([\d.]+)(.*)$/);
            return match ? { value: parseFloat(match[1]), unit: match[2] || 'px' } : { value: 0, unit: 'px' };
        };

        // Parse options from expression or use defaults
        let options = {};
        if (config.expression) {
            try {
                options = config.evaluate(config.expression);
            } catch (error) {
                console.error('Error parsing x-resize expression:', config.expression, error);
                options = {};
            }
        }
        const {
            snapDistance = 0,
            snapPoints = [],
            snapCloseX = null,
            snapDistanceX = null,
            snapDistanceY = null,
            snapPointsX = [],
            snapPointsY = [],
            snapCloseY = null,
            toggle = null,
            handles = ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
            saveWidth = null,
            saveHeight = null
        } = options;

        // Store handles for cleanup
        config.handles = [];

        // Parse constraints with units
        const constraints = {
            closeX: snapCloseX ? parseDimension(snapCloseX) : null,
            closeY: snapCloseY ? parseDimension(snapCloseY) : null
        };

        // Parse snap points with units
        const parsedSnapPoints = snapPoints.map(point => parseDimension(point));
        const parsedSnapPointsX = snapPointsX.map(point => parseDimension(point));
        const parsedSnapPointsY = snapPointsY.map(point => parseDimension(point));

        // Detect RTL context
        const isRTL = getComputedStyle(el).direction === 'rtl';

        // Handle mapping for resize behavior
        const handleMap = {
            // Physical directions (fixed)
            top: { edge: 'top', direction: 'vertical' },
            bottom: { edge: 'bottom', direction: 'vertical' },
            left: { edge: 'left', direction: 'horizontal' },
            right: { edge: 'right', direction: 'horizontal' },

            // Corners
            'top-left': { edge: 'top-left', direction: 'both', edges: ['top', 'left'] },
            'top-right': { edge: 'top-right', direction: 'both', edges: ['top', 'right'] },
            'bottom-left': { edge: 'bottom-left', direction: 'both', edges: ['bottom', 'left'] },
            'bottom-right': { edge: 'bottom-right', direction: 'both', edges: ['bottom', 'right'] },

            // Logical directions (RTL-aware)
            start: {
                edge: isRTL ? 'right' : 'left',
                direction: 'horizontal',
                logical: true
            },
            end: {
                edge: isRTL ? 'left' : 'right',
                direction: 'horizontal',
                logical: true
            },

            // Logical corners
            'top-start': {
                edge: isRTL ? 'top-right' : 'top-left',
                direction: 'both',
                edges: isRTL ? ['top', 'right'] : ['top', 'left'],
                logical: true
            },
            'top-end': {
                edge: isRTL ? 'top-left' : 'top-right',
                direction: 'both',
                edges: isRTL ? ['top', 'left'] : ['top', 'right'],
                logical: true
            },
            'bottom-start': {
                edge: isRTL ? 'bottom-right' : 'bottom-left',
                direction: 'both',
                edges: isRTL ? ['bottom', 'right'] : ['bottom', 'left'],
                logical: true
            },
            'bottom-end': {
                edge: isRTL ? 'bottom-left' : 'bottom-right',
                direction: 'both',
                edges: isRTL ? ['bottom', 'left'] : ['bottom', 'right'],
                logical: true
            }
        };

        // Create handles for each specified handle
        handles.forEach(handleName => {
            const handleInfo = handleMap[handleName];
            if (!handleInfo) return;

            const handle = document.createElement('span');
            handle.className = `resize-handle resize-handle-${handleName}`;
            handle.setAttribute('data-handle', handleName);

            let startX, startY, startWidth, startHeight;
            let currentSnap = null;

            // Convert constraints to pixels for calculations
            const pixelConstraints = {
                closeX: constraints.closeX ? convertToPixels(constraints.closeX.value, constraints.closeX.unit) : null,
                closeY: constraints.closeY ? convertToPixels(constraints.closeY.value, constraints.closeY.unit) : null
            };

            // Convert snap points to pixels
            const pixelSnapPoints = parsedSnapPoints.map(point => ({
                value: convertToPixels(point.value, point.unit),
                unit: point.unit
            }));
            const pixelSnapPointsX = parsedSnapPointsX.map(point => ({
                value: convertToPixels(point.value, point.unit),
                unit: point.unit
            }));
            const pixelSnapPointsY = parsedSnapPointsY.map(point => ({
                value: convertToPixels(point.value, point.unit),
                unit: point.unit
            }));

            const snapDistancePixels = convertToPixels(snapDistance, 'px');
            const snapDistanceXPixels = snapDistanceX ? convertToPixels(snapDistanceX, 'px') : snapDistancePixels;
            const snapDistanceYPixels = snapDistanceY ? convertToPixels(snapDistanceY, 'px') : snapDistancePixels;

            const handleMouseDown = (e) => {
                e.preventDefault();
                e.stopPropagation();

                startX = e.clientX;
                startY = e.clientY;
                startWidth = el.getBoundingClientRect().width;
                startHeight = el.getBoundingClientRect().height;

                // Show overlay
                const overlay = document.querySelector('.resize-overlay') || createOverlay();
                overlay.style.display = 'block';
                document.body.appendChild(overlay);

                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
            };

            const handleMouseMove = (e) => {
                const deltaX = e.clientX - startX;
                const deltaY = e.clientY - startY;

                let newWidth = startWidth;
                let newHeight = startHeight;

                // Calculate new dimensions based on handle type
                if (handleInfo.direction === 'horizontal' || handleInfo.direction === 'both') {
                    if (handleInfo.edge === 'left' || handleInfo.edge === 'top-left' || handleInfo.edge === 'bottom-left') {
                        newWidth = startWidth - deltaX;
                    } else if (handleInfo.edge === 'right' || handleInfo.edge === 'top-right' || handleInfo.edge === 'bottom-right') {
                        newWidth = startWidth + deltaX;
                    }
                }

                if (handleInfo.direction === 'vertical' || handleInfo.direction === 'both') {
                    if (handleInfo.edge === 'top' || handleInfo.edge === 'top-left' || handleInfo.edge === 'top-right') {
                        newHeight = startHeight - deltaY;
                    } else if (handleInfo.edge === 'bottom' || handleInfo.edge === 'bottom-left' || handleInfo.edge === 'bottom-right') {
                        newHeight = startHeight + deltaY;
                    }
                }

                // Handle snap-close behavior for width
                if (pixelConstraints.closeX !== null) {
                    // Close when element becomes smaller than threshold (dragging toward inside)
                    if (newWidth <= pixelConstraints.closeX) {
                        el.classList.add('resizable-closing');
                        currentSnap = 'closing';

                        if (toggle) {
                            config.evaluate(`${toggle} = false`);
                        }
                        return; // Exit early to prevent further width calculations
                    }
                }

                // Handle snap-close behavior for height
                if (pixelConstraints.closeY !== null) {
                    // Close when element becomes smaller than threshold (dragging toward inside)
                    if (newHeight <= pixelConstraints.closeY) {
                        el.classList.add('resizable-closing');
                        currentSnap = 'closing';

                        if (toggle) {
                            config.evaluate(`${toggle} = false`);
                        }
                        return; // Exit early to prevent further height calculations
                    }
                }

                // Apply constraints only if we're not closing
                // Note: maxWidth and maxHeight are now handled by CSS (e.g., Tailwind classes)

                // Handle normal snap points for width
                const widthSnapPoints = pixelSnapPointsX.length > 0 ? pixelSnapPointsX : pixelSnapPoints;
                const widthSnapDistance = snapDistanceXPixels;
                for (const point of widthSnapPoints) {
                    const distance = Math.abs(newWidth - point.value);
                    if (distance < widthSnapDistance) {
                        newWidth = point.value;
                        currentSnap = `${convertFromPixels(newWidth, point.unit, el)}${point.unit}`;
                        break;
                    }
                }

                // Handle normal snap points for height
                const heightSnapPoints = pixelSnapPointsY.length > 0 ? pixelSnapPointsY : pixelSnapPoints;
                const heightSnapDistance = snapDistanceYPixels;
                for (const point of heightSnapPoints) {
                    const distance = Math.abs(newHeight - point.value);
                    if (distance < heightSnapDistance) {
                        newHeight = point.value;
                        currentSnap = `${convertFromPixels(newHeight, point.unit, el)}${point.unit}`;
                        break;
                    }
                }

                // Convert back to original unit for display
                el.style.width = `${newWidth}px`;
                el.style.height = `${newHeight}px`;
                el.classList.remove('resizable-closing', 'resizable-closed');
                if (toggle) {
                    config.evaluate(`${toggle} = true`);
                }

                if (currentSnap !== 'closing') {
                    if (saveWidth) {
                        localStorage.setItem(`resizable-${saveWidth}`,
                            `${newWidth}|px`);
                    }
                    if (saveHeight) {
                        localStorage.setItem(`resizable-${saveHeight}`,
                            `${newHeight}|px`);
                    }
                }

                // Dispatch resize event
                el.dispatchEvent(new CustomEvent('resize', {
                    detail: {
                        width: newWidth,
                        height: newHeight,
                        unit: 'px',
                        snap: currentSnap,
                        closing: currentSnap === 'closing'
                    }
                }));
            };

            const handleMouseUp = () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);

                // Hide overlay
                const overlay = document.querySelector('.resize-overlay');
                if (overlay) {
                    overlay.style.display = 'none';
                }

                if (currentSnap === 'closing') {
                    el.classList.add('resizable-closed');
                }
            };

            handle.addEventListener('mousedown', handleMouseDown);
            el.appendChild(handle);
            config.handles.push(handle);
        });
    }

    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'resize-overlay';
        overlay.style.display = 'none';
        return overlay;
    }
}

// Track initialization to prevent duplicates
let resizePluginInitialized = false;

function ensureResizePluginInitialized() {
    if (resizePluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;

    resizePluginInitialized = true;
    initializeResizablePlugin();
}

// Expose on window for loader to call if needed
window.ensureResizePluginInitialized = ensureResizePluginInitialized;

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureResizePluginInitialized);
}

document.addEventListener('alpine:init', ensureResizePluginInitialized);

// If Alpine is already initialized when this script loads, initialize immediately
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureResizePluginInitialized, 0);
} else if (document.readyState === 'complete') {
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureResizePluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}