// mnfst:route.match:start — synced by the build from scripts/snippets/manifest.route.match.js; edit there
// x-route matching, shared by the router and the loader's parse-time pass

// Logical route path for a pathname under an app base path ('' at the root)
function routeLogicalPath(pathname, base) {
    if (!base) {
        const p = (pathname || '/').replace(/\/$/, '') || '/';
        if (p === '/' || p === '/index.html' || p === '/index') return '/';
        return p.startsWith('/') ? p : '/' + p;
    }
    if (pathname === base || pathname === base + '/') return '/';
    if (pathname.startsWith(base + '/')) {
        let logical = pathname.slice(base.length) || '/';
        if (logical === '/index.html' || logical === '/index') logical = '/';
        return logical;
    }
    if (pathname === base + '/index.html' || pathname === base + '/index') return '/';
    return pathname;
}

// One condition against a path; a leading locale code in the path is ignored
function routePathMatches(path, condition, localizationCodes) {
    const normalizedPath = path === '/' ? '/' : path.replace(/^\/+|\/+$/g, '') || '/';

    let pathToCheck = normalizedPath;
    if (localizationCodes.length > 0) {
        const pathSegments = normalizedPath.split('/').filter(segment => segment);
        if (pathSegments.length > 0 && localizationCodes.includes(pathSegments[0])) {
            pathToCheck = pathSegments.slice(1).join('/') || '/';
        }
    }

    // Wildcards
    if (condition.includes('*')) {
        if (condition === '*') return true;
        const wildcardPattern = condition.replace('*', '');
        const normalizedPattern = wildcardPattern.replace(/^\/+|\/+$/g, '');
        return pathToCheck.startsWith(normalizedPattern + '/');
    }

    // Exact (=)
    if (condition.startsWith('=')) {
        const exactPath = condition.slice(1);
        if (exactPath === '/') {
            return pathToCheck === '/' || pathToCheck === '';
        }
        const normalizedExactPath = exactPath.replace(/^\/+|\/+$/g, '');
        return pathToCheck === normalizedExactPath;
    }

    // Path and subpaths (/)
    if (condition.startsWith('/')) {
        if (condition === '/') {
            return pathToCheck === '/' || pathToCheck === '';
        }
        const routePath = condition.replace(/^\//, '');
        return pathToCheck === routePath || pathToCheck.startsWith(routePath + '/');
    }

    // Substring
    return pathToCheck.includes(condition);
}

// A comma list of conditions ('!' negates); null when the list has '!*', which needs every defined route
function routeConditionsMatch(routeCondition, normalizedPath, matches) {
    const conditions = routeCondition.split(',').map(cond => cond.trim());
    if (conditions.includes('!*')) return null;
    const positiveConditions = conditions.filter(cond => !cond.startsWith('!'));
    const negativeConditions = conditions
        .filter(cond => cond.startsWith('!'))
        .map(cond => cond.slice(1));
    const hasNegativeMatch = negativeConditions.some(cond => matches(normalizedPath, cond));
    const hasPositiveMatch = positiveConditions.length === 0 || positiveConditions.some(cond => matches(normalizedPath, cond));
    return hasPositiveMatch && !hasNegativeMatch;
}
// mnfst:route.match:end
