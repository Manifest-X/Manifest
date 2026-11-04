/* Manifest Submissions */

(function () {

if (typeof window === 'undefined' || window.ManifestSubmissions) return;

const EVENTS = { sent: 'submit-sent', error: 'submit-error' };

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

function controlsNamed(form, name) {
    return [...form.elements].filter(c => c.name === name && typeof c.setCustomValidity === 'function');
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
        for (const c of controlsNamed(form, field)) {
            c.setCustomValidity(message || 'Invalid value');
            marked.push(c);
        }
    }
    form.__mnfstSubmitErrors = marked;
    if (marked[0]) marked[0].reportValidity();
}

function request(form, submitter) {
    const has = (a) => submitter && submitter.hasAttribute(a);
    const action = has('formaction') ? submitter.formAction : form.action;
    const method = (has('formmethod') ? submitter.formMethod : form.method || 'get').toLowerCase();
    const enctype = has('formenctype') ? submitter.formEnctype : form.enctype;
    const data = new FormData(form);
    if (submitter && submitter.name) data.append(submitter.name, submitter.value);
    const headers = { Accept: 'application/json' };
    if (method === 'get') {
        const url = new URL(action, document.baseURI);
        url.search = new URLSearchParams(data).toString();
        return { url: url.href, init: { method: 'GET', headers } };
    }
    // Same body the browser would send without script
    const body = enctype === 'multipart/form-data' ? data : new URLSearchParams(data);
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

async function send(form, submitter) {
    form.__mnfstSubmitting = true;
    form.setAttribute('data-state', 'sending');
    form.setAttribute('aria-busy', 'true');
    clearErrors(form);

    let response = null, data = null, failure = null;
    try {
        const { url, init } = request(form, submitter);
        response = await fetch(url, init);
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
    if (e.defaultPrevented || !(form instanceof HTMLFormElement) || !form.hasAttribute('x-submit')) return;
    const submitter = e.submitter || null;
    const method = ((submitter && submitter.hasAttribute('formmethod')) ? submitter.formMethod : form.method || '').toLowerCase();
    if (method === 'dialog') return;
    e.preventDefault();
    if (form.__mnfstSubmitting) return;
    send(form, submitter);
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
