/* Manifest Toasts */

const TOAST_DURATION = 3000; // Default duration in ms

function initializeToastPlugin() {

    // Helper function to get or create container
    const getContainer = () => {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        return container;
    };

    // Helper function to create icon element
    const createIconElement = (iconName) => {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'iconify';
        iconSpan.setAttribute('data-icon', iconName);
        if (window.Iconify) {
            window.Iconify.scan(iconSpan);
        }
        return iconSpan;
    };

    // Helper function to show toast
    const showToast = (message, { type = '', duration = TOAST_DURATION, dismissible = false, fixed = false, icon = null } = {}) => {
        const container = getContainer();

        // Create toast element
        const toast = document.createElement('div');
        toast.setAttribute('role', 'alert');
        toast.setAttribute('class', type ? `toast ${type}` : 'toast');

        // Create content with optional icon
        const contentHtml = `
            ${icon ? '<span class="toast-icon"></span>' : ''}
            <div class="toast-content">${message}</div>
            ${dismissible || fixed ? '<button class="toast-dismiss-button" aria-label="Dismiss"></button>' : ''}
        `;

        toast.innerHTML = contentHtml;

        // Add icon if specified
        if (icon) {
            const iconContainer = toast.querySelector('.toast-icon');
            iconContainer.appendChild(createIconElement(icon));
        }

        // Add to container
        container.appendChild(toast);

        // Force a reflow before adding the entry class
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                toast.classList.add('toast-entry');
            });
        });

        // Handle dismiss button if present
        if (dismissible || fixed) {
            toast.querySelector('.toast-dismiss-button')?.addEventListener('click', () => {
                removeToast(toast);
            });
        }

        // Auto dismiss after duration (unless fixed)
        if (!fixed) {
            const timeout = setTimeout(() => {
                removeToast(toast);
            }, duration);

            // Pause timer on hover
            toast.addEventListener('mouseenter', () => {
                clearTimeout(timeout);
            });

            // Resume timer on mouse leave
            toast.addEventListener('mouseleave', () => {
                setTimeout(() => {
                    removeToast(toast);
                }, duration / 2);
            });
        }
    };

    // Helper function to remove toast with animation
    const removeToast = (toast) => {
        toast.classList.remove('toast-entry');
        toast.classList.add('toast-exit');

        // Track all transitions
        let transitions = 0;
        const totalTransitions = 2; // opacity and transform

        toast.addEventListener('transitionend', (e) => {
            transitions++;
            // Only remove the toast after all transitions complete
            if (transitions >= totalTransitions) {
                // Set height to 0 and opacity to 0 before removing
                // This allows other toasts to smoothly animate to their new positions
                toast.style.height = `${toast.offsetHeight}px`;
                toast.offsetHeight; // Force reflow
                toast.style.height = '0';
                toast.style.margin = '0';
                toast.style.padding = '0';

                // Finally remove the element after the collapse animation
                toast.addEventListener('transitionend', () => {
                    toast.remove();
                }, { once: true });
            }
        });
    };

    // Add toast directive
    Alpine.directive('toast', (el, { modifiers, expression }, { evaluate }) => {
        // Parse options from modifiers
        const options = {
            type: modifiers.includes('brand') ? 'brand' :
                modifiers.includes('positive') ? 'positive' :
                    modifiers.includes('negative') ? 'negative' :
                        modifiers.includes('accent') ? 'accent' : '',
            dismissible: modifiers.includes('dismiss'),
            fixed: modifiers.includes('fixed')
        };

        // Find duration modifier (any number)
        const durationModifier = modifiers.find(mod => !isNaN(mod));
        if (durationModifier) {
            options.duration = Number(durationModifier);
        } else {
            options.duration = modifiers.includes('long') ? TOAST_DURATION * 2 : TOAST_DURATION;
        }

        // Handle both static and dynamic expressions
        let message;
        try {
            // Check if expression starts with $x (data sources)
            if (expression.startsWith('$x.')) {
                // Use evaluate for $x expressions to access collections
                message = evaluate(expression);
            } else if (expression.includes('<') && expression.includes('>')) {
                // Treat as literal HTML string - preserve spaces and formatting
                // Escape quotes to prevent syntax errors, but keep the HTML intact
                const escapedExpression = expression.replace(/'/g, "\\'");
                message = evaluate(`'${escapedExpression}'`);
            } else if (expression.includes('+') || expression.includes('`') || expression.includes('${')) {
                // Try to evaluate as a dynamic expression
                message = evaluate(expression);
            } else {
                // Use as static string
                message = expression;
            }
        } catch (e) {
            // If evaluation fails, use the expression as a static string
            message = expression;
        }

        // Store the toast options on the element
        el._toastOptions = { message, options };

        // Add click handler that works with other handlers
        const originalClick = el.onclick;
        el.onclick = (e) => {
            // Call original click handler if it exists
            if (originalClick) {
                originalClick.call(el, e);
            }
            // Show toast after original handler
            showToast(message, options);
        };
    });

    // Add toast magic to Alpine
    Alpine.magic('toast', () => {
        // Create the base toast function
        const toast = (message, options = {}) => {
            showToast(message, { ...options, type: '' });
        };

        // Add type methods
        toast.brand = (message, options = {}) => {
            showToast(message, { ...options, type: 'brand' });
        };

        toast.accent = (message, options = {}) => {
            showToast(message, { ...options, type: 'accent' });
        };

        toast.positive = (message, options = {}) => {
            showToast(message, { ...options, type: 'positive' });
        };

        toast.negative = (message, options = {}) => {
            showToast(message, { ...options, type: 'negative' });
        };

        // Add dismiss variants
        toast.dismiss = (message, options = {}) => {
            showToast(message, { ...options, type: '', dismissible: true });
        };

        toast.brand.dismiss = (message, options = {}) => {
            showToast(message, { ...options, type: 'brand', dismissible: true });
        };

        toast.accent.dismiss = (message, options = {}) => {
            showToast(message, { ...options, type: 'accent', dismissible: true });
        };

        toast.positive.dismiss = (message, options = {}) => {
            showToast(message, { ...options, type: 'positive', dismissible: true });
        };

        toast.negative.dismiss = (message, options = {}) => {
            showToast(message, { ...options, type: 'negative', dismissible: true });
        };

        // Add fixed variants
        toast.fixed = (message, options = {}) => {
            showToast(message, { ...options, type: '', fixed: true });
        };

        toast.brand.fixed = (message, options = {}) => {
            showToast(message, { ...options, type: 'brand', fixed: true });
        };

        toast.accent.fixed = (message, options = {}) => {
            showToast(message, { ...options, type: 'accent', fixed: true });
        };

        toast.positive.fixed = (message, options = {}) => {
            showToast(message, { ...options, type: 'positive', fixed: true });
        };

        toast.negative.fixed = (message, options = {}) => {
            showToast(message, { ...options, type: 'negative', fixed: true });
        };

        return toast;
    });
}

// Track initialization to prevent duplicates
let toastPluginInitialized = false;

function ensureToastPluginInitialized() {
    if (toastPluginInitialized) {
        return;
    }
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') {
        return;
    }

    toastPluginInitialized = true;
    initializeToastPlugin();
}

// Expose on window for loader to call if needed
window.ensureToastPluginInitialized = ensureToastPluginInitialized;

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureToastPluginInitialized);
}

document.addEventListener('alpine:init', ensureToastPluginInitialized);

// If Alpine is already initialized when this script loads, initialize immediately
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureToastPluginInitialized, 0);
} else if (document.readyState === 'complete') {
    // If document is already loaded but Alpine isn't ready yet, wait for it
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureToastPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
} 