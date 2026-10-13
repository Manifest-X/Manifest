// mnfst:expressions:start — synced by the build from scripts/snippets/manifest.expressions.js; edit there
// Directive values: any JS expression evaluates; text that isn't one stays verbatim.

const EXPR_BARE_IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u;
// No name, string or template: numbers, dates, ratios ("24/7", "2026-10-13") stay text
const EXPR_HAS_TOKEN = /[\p{L}$_'"`]/u;

function exprParses(src) {
    try { new Function('return (' + src + '\n)'); return true; } catch { return false; }
}

function exprInScope(el, name) {
    try { return name in Alpine.$data(el); } catch { return false; }
}

// Errors come back as values: unresolved names read as plain text
// ("Re-run", "Hello, world"); other errors warn against the authored expression
const exprGuarded = (src) =>
    '(() => { try { return (' + src + '\n) } catch (e) { return { __exprError: e } } })()';

function exprUnwrap(v, el, src) {
    const err = v && typeof v === 'object' && v.__exprError;
    if (!(err instanceof Error)) return v;
    if (err instanceof ReferenceError) return undefined;
    console.warn(`Alpine Expression Error: ${err.message}\n\nExpression: "${src}"\n\n`, el);
    return null;
}

// null for static text; else (cb) => cb(value, asText), asText meaning the
// authored text shows instead (unresolved name, undefined, NaN)
function expressionResolver(el, src, evaluateLater) {
    if (src.startsWith('$x.')) {
        const getValue = evaluateLater(src);
        return (cb) => getValue(v => cb(v, false));
    }
    if (!EXPR_HAS_TOKEN.test(src) || !exprParses(src)) return null;
    let getValue;
    if (EXPR_BARE_IDENTIFIER.test(src)) {
        // Single word: a scope value or magic, else text (never a global like Image or close)
        const getWord = evaluateLater(exprGuarded(src));
        getValue = (cb) => (src.startsWith('$') || exprInScope(el, src)) ? getWord(cb) : cb(undefined);
    } else {
        getValue = evaluateLater(exprGuarded(src));
    }
    return (cb) => getValue(raw => {
        const v = exprUnwrap(raw, el, src);
        cb(v, v === undefined || Number.isNaN(v));
    });
}
// mnfst:expressions:end
