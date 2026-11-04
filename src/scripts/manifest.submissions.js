/* Manifest Submissions */

(function () {

if (typeof window === 'undefined' || window.ManifestSubmissions) return;

const EVENTS = { sent: 'submit:sent', error: 'submit:error' };

// Server field errors: { fields: { name: message } } or { errors: [{ field, message }] }
function fieldErrors(data) {
    if (!data || typeof data !== 'object') return [];
    if (data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields)) {
        return Object.entries(data.fields).map(([field, message]) => ({ field, message: String(message ?? '') }));
    }
    if (Array.isArray(data.errors)) {
        return data.errors.filter(e => e && e.field).map(e => ({ field: String(e.field), message: String(e.message ?? e.code ?? '') }));
    }
    return [];
}

// Form properties are shadowed by controls named like them (<input name="action">)
const attr = (el, name) => el ? Element.prototype.getAttribute.call(el, name) : null;
const controlsOf = (form) => [...Reflect.get(HTMLFormElement.prototype, 'elements', form)];

// Only fields the visitor can see and edit; anything else would block every later submit
function editable(c) {
    if (typeof c.setCustomValidity !== 'function' || c.willValidate === false) return false;
    if (c.type === 'hidden' || c.readOnly || c.matches(':disabled')) return false;
    if (c.closest('[hidden], [inert]')) return false;
    const fieldset = c.closest('fieldset[disabled]');
    if (fieldset && !fieldset.querySelector(':scope > legend')?.contains(c)) return false;
    const closed = c.closest('details:not([open])');
    if (closed && !c.closest('summary')) return false;
    return typeof c.checkVisibility === 'function' ? c.checkVisibility({ visibilityProperty: true }) : true;
}

function clearErrors(form, name) {
    const marked = form.__mnfstSubmitErrors;
    if (!marked) return;
    form.__mnfstSubmitErrors = marked.filter(c => {
        if (name !== undefined && c.name !== name) return true;
        c.setCustomValidity('');
        return false;
    });
}

function showErrors(form, errors) {
    const marked = [];
    for (const { field, message } of errors) {
        for (const c of controlsOf(form)) {
            if (c.name !== field || !editable(c)) continue;
            c.setCustomValidity(message || 'Invalid value');
            marked.push(c);
        }
    }
    form.__mnfstSubmitErrors = marked;
    if (marked[0]) marked[0].reportValidity();
}

const URLENCODED = 'application/x-www-form-urlencoded', MULTIPART = 'multipart/form-data', TEXT = 'text/plain';
const pick = (value, allowed, fallback) => {
    const v = (value || '').trim().toLowerCase();
    return allowed.includes(v) ? v : fallback;
};

let submitterArg;
function supportsSubmitterArg() {
    if (submitterArg === undefined) {
        try {
            const f = document.createElement('form'), b = document.createElement('button');
            b.name = 's'; b.value = '1'; f.appendChild(b);
            submitterArg = new FormData(f, b).get('s') === '1';
        } catch { submitterArg = false; }
    }
    return submitterArg;
}

// Fields in native order, the submitter included; null when only the browser can build them
function collect(form, submitter) {
    if (submitter && supportsSubmitterArg()) {
        try { return new FormData(form, submitter); } catch { }
    }
    const data = new FormData(form);
    if (!submitter) return data;
    if (submitter.type === 'image') return null;
    if (submitter.name) data.append(submitter.name, submitter.value);
    return data;
}

// The request a native submit would make, or null to leave the submit to the browser
function plan(form, submitter) {
    const target = attr(submitter, 'formtarget') ?? attr(form, 'target') ?? attr(document.querySelector('base[target]'), 'target') ?? '';
    if (!['', '_self'].includes(target.trim().toLowerCase())) return null;
    const method = pick(attr(submitter, 'formmethod') ?? attr(form, 'method'), ['get', 'post', 'dialog'], 'get');
    if (method === 'dialog') return null;
    const enctype = method === 'get' ? URLENCODED : pick(attr(submitter, 'formenctype') ?? attr(form, 'enctype'), [URLENCODED, MULTIPART, TEXT], URLENCODED);
    const raw = attr(submitter, 'formaction') ?? attr(form, 'action');
    const action = raw ? new URL(raw, form.baseURI).href : document.URL;

    const data = collect(form, submitter);
    if (!data) return null;
    const files = [...data.values()].some(v => typeof v !== 'string' && (v.name || v.size));
    if (files && enctype !== MULTIPART) return null;
    const pairs = () => [...data].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]);

    const headers = { Accept: 'application/json' };
    if (method === 'get') {
        const url = new URL(action);
        url.search = new URLSearchParams(pairs()).toString();
        return { url: url.href, init: { method: 'GET', headers } };
    }
    const body = enctype === MULTIPART ? data
        : enctype === TEXT ? pairs().map(([k, v]) => `${k}=${v}\r\n`).join('')
        : new URLSearchParams(pairs());
    return { url: action, init: { method: method.toUpperCase(), headers, body } };
}

async function parse(response) {
    try {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

function errorOf(response, data) {
    if (!response) return { error: 'network_error', message: '' };
    const first = data && Array.isArray(data.errors) ? data.errors[0] : null;
    const error = (data && typeof data.error === 'string' && data.error) || (first && first.code) || 'http_error';
    const message = (data && typeof data.message === 'string' && data.message) || (first && first.message) || response.statusText || '';
    return { error, message };
}

// Turnstile tokens are single-use
function resetTurnstile(form) {
    const widget = form.querySelector('.cf-turnstile') || form.querySelector('[name="cf-turnstile-response"]')?.parentElement;
    if (!widget || !window.turnstile || typeof window.turnstile.reset !== 'function') return;
    try { window.turnstile.reset(widget); } catch { }
}

async function send(form, submitter = null, request = plan(form, submitter)) {
    if (!request) return { ok: false, status: 0, data: null, response: null, error: 'unsupported', message: '' };
    form.__mnfstSubmitting = true;
    form.setAttribute('data-state', 'sending');
    form.setAttribute('aria-busy', 'true');
    clearErrors(form);

    let response = null, data = null, failure = null;
    try {
        response = await fetch(request.url, request.init);
        data = await parse(response);
    } catch (e) {
        failure = e;
    }

    const ok = !!response && response.ok && !(data && data.ok === false);
    const detail = { ok, status: response ? response.status : 0, data, response, error: null, message: '' };
    if (!ok) Object.assign(detail, errorOf(response, data), failure ? { message: failure.message || '' } : {});

    form.__mnfstSubmitting = false;
    form.removeAttribute('aria-busy');
    form.setAttribute('data-state', ok ? 'sent' : 'error');
    resetTurnstile(form);
    if (!ok) {
        const errors = fieldErrors(data);
        if (errors.length) showErrors(form, errors);
    }
    form.dispatchEvent(new CustomEvent(ok ? EVENTS.sent : EVENTS.error, { bubbles: true, detail }));
    return detail;
}

// Delegated, so forms added later, prerendered or outside Alpine work alike.
// Runs after native validation; an author handler that prevents default opts out.
document.addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented || !(form instanceof HTMLFormElement) || attr(form, 'x-submit') === null) return;
    if (form.__mnfstSubmitting) return e.preventDefault();
    const submitter = e.submitter || null;
    let request = null;
    try { request = plan(form, submitter); } catch { }
    if (!request) return;
    e.preventDefault();
    send(form, submitter, request);
});

// A field's server error clears once it is edited
const onEdit = (e) => {
    const c = e.target;
    if (c && c.form && c.name && c.form.__mnfstSubmitErrors) clearErrors(c.form, c.name);
};
document.addEventListener('input', onEdit, true);
document.addEventListener('change', onEdit, true);

window.ManifestSubmissions = { events: EVENTS, send };

})();
