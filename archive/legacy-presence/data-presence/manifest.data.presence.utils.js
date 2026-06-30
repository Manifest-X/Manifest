/* Manifest Data Sources - Presence Utilities */

// Track active presence subscriptions
const presenceSubscriptions = new Map(); // Map<channelId, { unsubscribe, cursors, updateInterval }>

// Cursor position tracking per channel
const cursorPositions = new Map(); // Map<channelId, { x, y }>

// Generate a color for a user based on their ID
function getUserColor(userId) {
    if (!userId) return '#666';

    // Simple hash function to generate consistent color
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }

    // Generate a bright, saturated color
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
}

// Smooth cursor interpolation using velocity (dead reckoning)
// This allows smooth cursor rendering between updates without frequent server writes
// Based on techniques used by Figma, Google Docs, and other collaborative tools
function interpolateCursorPosition(lastKnown, velocity, elapsedMs) {
    if (!lastKnown || !velocity) {
        return lastKnown;
    }

    // Calculate predicted position based on velocity (dead reckoning)
    // Position = LastKnown + Velocity * Time
    const elapsedSeconds = elapsedMs / 1000;
    const predictedX = lastKnown.x + (velocity.vx || 0) * elapsedSeconds;
    const predictedY = lastKnown.y + (velocity.vy || 0) * elapsedSeconds;

    // Apply damping to velocity (gradually slow down if no new updates)
    // This prevents cursors from flying off screen if user stops moving
    const dampingFactor = Math.max(0, 1 - (elapsedMs / 2000)); // Full stop after 2 seconds
    const dampedVx = (velocity.vx || 0) * dampingFactor;
    const dampedVy = (velocity.vy || 0) * dampingFactor;

    return {
        x: predictedX,
        y: predictedY,
        vx: dampedVx,
        vy: dampedVy,
        interpolated: true // Flag to indicate this is interpolated, not actual position
    };
}

// Linear interpolation between two points (for rendering smooth paths)
function lerp(start, end, t) {
    // t should be between 0 and 1
    return start + (end - start) * t;
}

// Smooth interpolation with easing (ease-out for natural deceleration)
function smoothInterpolate(start, end, t) {
    // Ease-out cubic: t * (2 - t)
    const easedT = t * (2 - t);
    return lerp(start, end, easedT);
}

// Get user info from auth store
function getUserInfo() {
    if (typeof Alpine === 'undefined') return null;

    const authStore = Alpine.store('auth');
    if (!authStore || !authStore.user) return null;

    return {
        id: authStore.user.$id,
        name: authStore.user.name || authStore.user.email || 'Anonymous',
        email: authStore.user.email || null,
        color: getUserColor(authStore.user.$id)
    };
}

// Get Appwrite services
async function getAppwriteServices() {
    return await window.ManifestDataAppwrite._getAppwriteDataServices();
}

// Read CSS variable value (returns number in specified unit, or fallback)
function getCSSVariableValue(variableName, unit = 'ms', fallback = 0) {
    if (typeof document === 'undefined') return fallback;

    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(variableName)
        .trim();

    if (!value) return fallback;

    // Remove unit and parse as number
    const numValue = parseFloat(value);
    if (isNaN(numValue)) return fallback;

    // Convert to milliseconds if needed (for px values, return as-is)
    if (unit === 'ms' && value.endsWith('px')) {
        // For pixel values, return as-is (they're already in pixels)
        return numValue;
    } else if (unit === 'ms' && value.endsWith('ms')) {
        return numValue;
    } else if (unit === 'px' && value.endsWith('px')) {
        return numValue;
    }

    return numValue;
}

// Get presence configuration from manifest
async function getPresenceConfig() {
    try {
        const manifest = await window.ManifestDataConfig?.ensureManifest?.();
        return manifest?.data?.presence || {};
    } catch (error) {
        console.warn('[Manifest Presence] Failed to load manifest config:', error);
        return {};
    }
}
