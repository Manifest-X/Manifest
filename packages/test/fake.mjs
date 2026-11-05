// In-memory Appwrite backend shaped like the Web SDK (window.Appwrite).
// Manifest's real data plugins run on top of it, in happy-dom or a real browser.
//
// createFakeAppwrite is self-contained (no outer references) so the browser
// runner can inject it via Function#toString. Keep it that way.

export function createFakeAppwrite(options = {}) {
    const opts = {
        defaultLimit: 25,
        maxLimit: 5000,
        totalCap: 5000,
        caseSensitive: false,
        latency: 0,
        realtimeDelay: 0,
        start: '2026-01-01T00:00:00.000Z',
        user: null,
        teams: [],
        ...options
    };

    // Clock: fixed and advancing 1s per write, so fixtures and screenshots are stable
    let clockMs = Date.parse(opts.start);
    const now = () => { clockMs += 1000; return iso(clockMs); };
    const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');

    let idSeq = 0;
    const uniqueId = () => (++idSeq).toString(16).padStart(20, '0');

    let randSeed = 1;
    const random = () => { randSeed = (randSeed * 16807) % 2147483647; return (randSeed - 1) / 2147483646; };

    class AppwriteException extends Error {
        constructor(message, code = 0, type = '', response = '') {
            super(message);
            this.name = 'AppwriteException';
            this.code = code;
            this.type = type;
            this.response = response;
        }
    }
    const fail = (code, type, message) => { throw new AppwriteException(message, code, type, JSON.stringify({ message, code, type })); };

    // Storage: databases -> tables -> { rows: Map(id -> row), seq }
    const databases = new Map();
    const buckets = new Map();
    const calls = [];
    const failures = [];
    const listeners = new Set();

    function tableOf(databaseId, tableId, create) {
        let db = databases.get(databaseId);
        if (!db) {
            if (!create) fail(404, 'database_not_found', 'Database not found');
            db = new Map();
            databases.set(databaseId, db);
        }
        let table = db.get(tableId);
        if (!table) {
            if (!create) fail(404, 'table_not_found', 'Table with the requested ID could not be found.');
            table = { rows: new Map(), seq: 0 };
            db.set(tableId, table);
        }
        return table;
    }

    function bucketOf(bucketId, create) {
        let bucket = buckets.get(bucketId);
        if (!bucket) {
            if (!create) fail(404, 'storage_bucket_not_found', 'Storage bucket with the requested ID could not be found.');
            bucket = { rows: new Map(), seq: 0 };
            buckets.set(bucketId, bucket);
        }
        return bucket;
    }

    const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
    const SYSTEM = new Set(['$id', '$sequence', '$tableId', '$databaseId', '$createdAt', '$updatedAt', '$permissions', '$bucketId']);
    const userData = (data) => {
        const out = {};
        for (const [k, v] of Object.entries(data || {})) if (!SYSTEM.has(k)) out[k] = clone(v);
        return out;
    };

    function makeRow(table, databaseId, tableId, rowId, data, permissions) {
        const at = data && data.$createdAt ? data.$createdAt : now();
        return {
            $id: rowId,
            $sequence: ++table.seq,
            $tableId: tableId,
            $databaseId: databaseId,
            $createdAt: at,
            $updatedAt: data && data.$updatedAt ? data.$updatedAt : at,
            $permissions: permissions || (data && data.$permissions) || [],
            ...userData(data)
        };
    }

    // Queries: Appwrite JSON strings ({method, attribute, values}) or objects
    function parse(q) {
        if (typeof q === 'string') {
            try { q = JSON.parse(q); } catch { fail(400, 'general_query_invalid', `Invalid query: ${q}`); }
        }
        if (!q || typeof q.method !== 'string') fail(400, 'general_query_invalid', 'Invalid query: missing method');
        if ((q.method === 'or' || q.method === 'and') && Array.isArray(q.values)) {
            return { ...q, values: q.values.map(parse) };
        }
        return { ...q, values: Array.isArray(q.values) ? q.values : (q.values === undefined ? [] : [q.values]) };
    }

    const norm = (v) => (!opts.caseSensitive && typeof v === 'string') ? v.toLowerCase() : v;
    const isNil = (v) => v === null || v === undefined;
    const eq = (a, b) => norm(a) === norm(b);
    const words = (s) => String(s).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    const field = (row, attr) => {
        if (attr === '$createdAt' || attr === '$updatedAt' || attr === '$id' || attr === '$sequence') return row[attr];
        return row[attr];
    };

    const FILTERS = {
        equal: (v, vals) => Array.isArray(v) ? vals.some(x => v.some(el => eq(el, x))) : vals.some(x => eq(v, x)),
        notEqual: (v, vals) => !FILTERS.equal(v, vals),
        lessThan: (v, [b]) => !isNil(v) && norm(v) < norm(b),
        lessThanEqual: (v, [b]) => !isNil(v) && norm(v) <= norm(b),
        greaterThan: (v, [b]) => !isNil(v) && norm(v) > norm(b),
        greaterThanEqual: (v, [b]) => !isNil(v) && norm(v) >= norm(b),
        between: (v, [a, b]) => !isNil(v) && norm(v) >= norm(a) && norm(v) <= norm(b),
        notBetween: (v, vals) => !isNil(v) && !FILTERS.between(v, vals),
        isNull: (v) => isNil(v),
        isNotNull: (v) => !isNil(v),
        exists: (v) => v !== undefined,
        notExists: (v) => v === undefined,
        startsWith: (v, vals) => typeof v === 'string' && vals.some(x => norm(v).startsWith(norm(String(x)))),
        endsWith: (v, vals) => typeof v === 'string' && vals.some(x => norm(v).endsWith(norm(String(x)))),
        notStartsWith: (v, vals) => !FILTERS.startsWith(v, vals),
        notEndsWith: (v, vals) => !FILTERS.endsWith(v, vals),
        contains: (v, vals) => Array.isArray(v)
            ? vals.some(x => v.some(el => eq(el, x)))
            : typeof v === 'string' && vals.some(x => norm(v).includes(norm(String(x)))),
        containsAny: (v, vals) => FILTERS.contains(v, vals),
        containsAll: (v, vals) => Array.isArray(v) && vals.every(x => v.some(el => eq(el, x))),
        notContains: (v, vals) => !FILTERS.contains(v, vals),
        // Fulltext (MariaDB boolean mode, terms as prefixes, OR across terms)
        search: (v, [term]) => {
            if (isNil(v)) return false;
            const terms = words(term);
            if (!terms.length) return true;
            const ws = words(v);
            return terms.some(t => ws.some(w => w.startsWith(t)));
        },
        notSearch: (v, vals) => !FILTERS.search(v, vals),
        regex: (v, [pattern]) => typeof v === 'string' && new RegExp(pattern).test(v)
    };
    const DATE_FILTERS = {
        createdBefore: ['$createdAt', 'lessThan'],
        createdAfter: ['$createdAt', 'greaterThan'],
        createdBetween: ['$createdAt', 'between'],
        updatedBefore: ['$updatedAt', 'lessThan'],
        updatedAfter: ['$updatedAt', 'greaterThan'],
        updatedBetween: ['$updatedAt', 'between']
    };
    const PAGING = new Set(['limit', 'offset', 'cursorAfter', 'cursorBefore', 'orderAsc', 'orderDesc', 'orderRandom', 'select']);

    function matches(row, q) {
        if (q.method === 'and') return q.values.every(sub => matches(row, sub));
        if (q.method === 'or') return q.values.some(sub => matches(row, sub));
        if (DATE_FILTERS[q.method]) {
            const [attr, op] = DATE_FILTERS[q.method];
            return FILTERS[op](row[attr], q.values);
        }
        const fn = FILTERS[q.method];
        if (!fn) fail(400, 'general_query_invalid', `Invalid query method: ${q.method}`);
        return fn(field(row, q.attribute), q.values);
    }

    function compareBy(orders) {
        return (a, b) => {
            for (const o of orders) {
                const x = norm(a[o.attribute]);
                const y = norm(b[o.attribute]);
                if (x === y) continue;
                // MariaDB: NULL sorts first ascending, last descending
                let c;
                if (isNil(x)) c = -1;
                else if (isNil(y)) c = 1;
                else c = x < y ? -1 : 1;
                return o.dir === 'desc' ? -c : c;
            }
            return a.$sequence - b.$sequence;
        };
    }

    function list(store, queries = [], { total: wantTotal = true, kind = 'rows' } = {}) {
        const parsed = (queries || []).map(parse);
        const filters = [];
        const orders = [];
        // Like Appwrite (utopia Query::groupByType): the first limit, offset and cursor win
        let limit = null;
        let offset = null;
        let cursor = null;
        let shuffle = false;
        let select = null;
        for (const q of parsed) {
            switch (q.method) {
                case 'limit': {
                    const n = Number(q.values[0]);
                    if (!Number.isInteger(n) || n < 0 || n > opts.maxLimit) {
                        fail(400, 'general_query_invalid', `Invalid query: Invalid limit: Value must be a valid range between 0 and ${opts.maxLimit}`);
                    }
                    if (limit === null) limit = n;
                    break;
                }
                case 'offset': if (offset === null) offset = Number(q.values[0]); break;
                case 'cursorAfter': if (!cursor) cursor = { id: q.values[0], dir: 'after' }; break;
                case 'cursorBefore': if (!cursor) cursor = { id: q.values[0], dir: 'before' }; break;
                case 'orderAsc': orders.push({ attribute: q.attribute, dir: 'asc' }); break;
                case 'orderDesc': orders.push({ attribute: q.attribute, dir: 'desc' }); break;
                case 'orderRandom': shuffle = true; break;
                case 'select': select = q.values; break;
                default: filters.push(q);
            }
        }
        if (limit === null) limit = opts.defaultLimit;
        if (offset === null) offset = 0;
        const cmp = compareBy(orders);
        let rows = [...store.rows.values()].filter(r => filters.every(q => matches(r, q))).sort(cmp);
        const count = rows.length;
        if (shuffle) rows = rows.map(r => [random(), r]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
        if (cursor) {
            const at = store.rows.get(cursor.id);
            if (!at) fail(400, 'general_cursor_not_found', `Row '${cursor.id}' for the 'cursor' value not found.`);
            if (cursor.dir === 'after') {
                rows = rows.filter(r => cmp(r, at) > 0).slice(offset, offset + limit);
            } else {
                const before = rows.filter(r => cmp(r, at) < 0);
                rows = before.slice(Math.max(0, before.length - offset - limit), before.length - offset);
            }
        } else {
            rows = rows.slice(offset, offset + limit);
        }
        let out = rows.map(clone);
        if (select && !select.includes('*')) {
            out = out.map(r => {
                const o = {};
                for (const k of Object.keys(r)) if (k.startsWith('$') || select.includes(k)) o[k] = r[k];
                return o;
            });
        }
        return { total: wantTotal === false ? 0 : Math.min(count, opts.totalCap), [kind]: out };
    }

    // Realtime: query-capable shape (SDK >= 25), payloads filtered server-side
    const REALTIME_OPS = new Set(['equal', 'notEqual', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual', 'isNull', 'isNotNull', 'and', 'or']);
    const subscriptions = new Map();
    let subSeq = 0;

    function realtimeMatch(payload, queries) {
        return queries.every(q => {
            if (!REALTIME_OPS.has(q.method)) return true;
            if (q.method === 'and') return realtimeMatch(payload, q.values);
            if (q.method === 'or') return q.values.some(sub => realtimeMatch(payload, [sub]));
            return matches(payload, q);
        });
    }

    function eventNames(parts, action) {
        // Every wildcard variant Appwrite sends, e.g. databases.*.tables.t.rows.*.update
        const out = [];
        const n = parts.length;
        for (let mask = 0; mask < (1 << n); mask++) {
            const segs = parts.map((p, i) => (mask & (1 << i)) ? [p[0], '*'] : p);
            const base = segs.map(s => s.join('.')).join('.');
            out.push(`${base}.${action}`, base);
        }
        return [...new Set(out)];
    }

    function emit(channels, events, payload) {
        const message = { events, channels, timestamp: iso(clockMs), payload: clone(payload) };
        const deliver = () => {
            for (const [id, sub] of subscriptions) {
                if (!sub.channels.some(c => channels.includes(c))) continue;
                if (!realtimeMatch(payload, sub.queries)) continue;
                try { sub.callback({ ...message, payload: clone(payload), subscriptions: [id] }); } catch (e) { console.error(e); }
            }
            for (const fn of listeners) fn(message);
        };
        if (opts.realtimeDelay > 0) setTimeout(deliver, opts.realtimeDelay);
        else Promise.resolve().then(deliver);
    }

    function emitRow(action, row) {
        const db = row.$databaseId, t = row.$tableId, id = row.$id;
        const channels = ['rows', `databases.${db}.tables.${t}.rows`, `databases.${db}.tables.${t}.rows.${id}`,
            'documents', `databases.${db}.collections.${t}.documents`, `databases.${db}.collections.${t}.documents.${id}`];
        const events = [
            ...eventNames([['databases', db], ['tables', t], ['rows', id]], action),
            ...eventNames([['databases', db], ['collections', t], ['documents', id]], action)
        ];
        emit(channels, events, row);
    }

    function emitFile(action, file) {
        const b = file.bucketId, id = file.$id;
        emit(['files', `buckets.${b}.files`, `buckets.${b}.files.${id}`],
            eventNames([['buckets', b], ['files', id]], action), file);
    }

    // Calls: logged, delayed by latency, failable via failNext
    async function call(method, params, fn) {
        calls.push({ method, params: clone(params) });
        if (opts.latency > 0) await new Promise(r => setTimeout(r, opts.latency));
        else await Promise.resolve();
        const i = failures.findIndex(f => f.method === method || f.method === '*');
        if (i !== -1) {
            const [f] = failures.splice(i, 1);
            throw f.error instanceof Error ? f.error : new AppwriteException(f.error?.message || 'Server Error', f.error?.code || 500, f.error?.type || 'general_server_error');
        }
        return fn();
    }

    // SDK methods accept an params object or positional args
    const params = (first, rest, names) => {
        if (first && typeof first === 'object' && !Array.isArray(first)) return first;
        const p = {};
        [first, ...rest].forEach((v, i) => { if (names[i]) p[names[i]] = v; });
        return p;
    };

    // Backend operations (also used directly by tests to act as "another user")
    const backend = {
        createRow({ databaseId, tableId, rowId, data, permissions }) {
            const table = tableOf(databaseId, tableId);
            const id = rowId && rowId !== 'unique()' ? rowId : uniqueId();
            if (table.rows.has(id)) fail(409, 'row_already_exists', 'Row with the requested ID already exists. Try again with a different ID or use ID.unique() to generate a unique ID.');
            const row = makeRow(table, databaseId, tableId, id, data, permissions);
            table.rows.set(id, row);
            emitRow('create', row);
            return clone(row);
        },
        getRow({ databaseId, tableId, rowId }) {
            const row = tableOf(databaseId, tableId).rows.get(rowId);
            if (!row) fail(404, 'row_not_found', 'Row with the requested ID could not be found.');
            return clone(row);
        },
        updateRow({ databaseId, tableId, rowId, data, permissions }) {
            const table = tableOf(databaseId, tableId);
            const row = table.rows.get(rowId);
            if (!row) fail(404, 'row_not_found', 'Row with the requested ID could not be found.');
            Object.assign(row, userData(data), { $updatedAt: now() });
            if (permissions) row.$permissions = permissions;
            emitRow('update', row);
            return clone(row);
        },
        upsertRow({ databaseId, tableId, rowId, data, permissions }) {
            const table = tableOf(databaseId, tableId);
            if (!table.rows.has(rowId)) return backend.createRow({ databaseId, tableId, rowId, data, permissions });
            const row = table.rows.get(rowId);
            const fresh = makeRow(table, databaseId, tableId, rowId, data, permissions || row.$permissions);
            fresh.$sequence = row.$sequence;
            fresh.$createdAt = row.$createdAt;
            fresh.$updatedAt = now();
            table.seq--;
            table.rows.set(rowId, fresh);
            emitRow('update', fresh);
            return clone(fresh);
        },
        deleteRow({ databaseId, tableId, rowId }) {
            const table = tableOf(databaseId, tableId);
            const row = table.rows.get(rowId);
            if (!row) fail(404, 'row_not_found', 'Row with the requested ID could not be found.');
            table.rows.delete(rowId);
            emitRow('delete', row);
            return {};
        },
        incrementRowColumn({ databaseId, tableId, rowId, column, value = 1, max }) {
            const row = tableOf(databaseId, tableId).rows.get(rowId);
            if (!row) fail(404, 'row_not_found', 'Row with the requested ID could not be found.');
            let next = (Number(row[column]) || 0) + value;
            if (max !== undefined && next > max) fail(400, 'row_invalid_structure', `Value exceeds max ${max}`);
            return backend.updateRow({ databaseId, tableId, rowId, data: { [column]: next } });
        },
        decrementRowColumn({ databaseId, tableId, rowId, column, value = 1, min }) {
            const row = tableOf(databaseId, tableId).rows.get(rowId);
            if (!row) fail(404, 'row_not_found', 'Row with the requested ID could not be found.');
            let next = (Number(row[column]) || 0) - value;
            if (min !== undefined && next < min) fail(400, 'row_invalid_structure', `Value below min ${min}`);
            return backend.updateRow({ databaseId, tableId, rowId, data: { [column]: next } });
        },
        listRows({ databaseId, tableId, queries, total }) {
            return list(tableOf(databaseId, tableId), queries, { total, kind: 'rows' });
        },
        createFile({ bucketId, fileId, file, permissions }) {
            const bucket = bucketOf(bucketId);
            const id = fileId && fileId !== 'unique()' ? fileId : uniqueId();
            if (bucket.rows.has(id)) fail(409, 'storage_file_already_exists', 'A storage file with the requested ID already exists.');
            const at = now();
            const meta = {
                $id: id, $sequence: ++bucket.seq, bucketId, $createdAt: at, $updatedAt: at,
                $permissions: permissions || [], name: file?.name || id,
                mimeType: file?.type || file?.mimeType || 'application/octet-stream',
                sizeOriginal: file?.size || 0, chunksTotal: 1, chunksUploaded: 1, signature: ''
            };
            bucket.rows.set(id, meta);
            emitFile('create', meta);
            return clone(meta);
        },
        deleteFile({ bucketId, fileId }) {
            const bucket = bucketOf(bucketId);
            const file = bucket.rows.get(fileId);
            if (!file) fail(404, 'storage_file_not_found', 'The requested file could not be found.');
            bucket.rows.delete(fileId);
            emitFile('delete', file);
            return {};
        },
        listFiles({ bucketId, queries }) {
            return list(bucketOf(bucketId), queries, { kind: 'files' });
        }
    };

    // SDK surface
    const toQuery = (method, attribute, values) => {
        const q = { method };
        if (attribute !== undefined) q.attribute = attribute;
        if (values !== undefined) q.values = Array.isArray(values) ? values : [values];
        return JSON.stringify(q);
    };
    const Query = {
        equal: (a, v) => toQuery('equal', a, v),
        notEqual: (a, v) => toQuery('notEqual', a, v),
        lessThan: (a, v) => toQuery('lessThan', a, v),
        lessThanEqual: (a, v) => toQuery('lessThanEqual', a, v),
        greaterThan: (a, v) => toQuery('greaterThan', a, v),
        greaterThanEqual: (a, v) => toQuery('greaterThanEqual', a, v),
        between: (a, s, e) => toQuery('between', a, [s, e]),
        notBetween: (a, s, e) => toQuery('notBetween', a, [s, e]),
        isNull: (a) => toQuery('isNull', a),
        isNotNull: (a) => toQuery('isNotNull', a),
        exists: (a) => toQuery('exists', undefined, a),
        notExists: (a) => toQuery('notExists', undefined, a),
        startsWith: (a, v) => toQuery('startsWith', a, v),
        endsWith: (a, v) => toQuery('endsWith', a, v),
        notStartsWith: (a, v) => toQuery('notStartsWith', a, v),
        notEndsWith: (a, v) => toQuery('notEndsWith', a, v),
        contains: (a, v) => toQuery('contains', a, v),
        containsAny: (a, v) => toQuery('containsAny', a, v),
        containsAll: (a, v) => toQuery('containsAll', a, v),
        notContains: (a, v) => toQuery('notContains', a, v),
        search: (a, v) => toQuery('search', a, v),
        notSearch: (a, v) => toQuery('notSearch', a, v),
        regex: (a, v) => toQuery('regex', a, v),
        select: (a) => toQuery('select', undefined, a),
        orderAsc: (a) => toQuery('orderAsc', a),
        orderDesc: (a) => toQuery('orderDesc', a),
        orderRandom: () => toQuery('orderRandom'),
        cursorAfter: (id) => toQuery('cursorAfter', undefined, id),
        cursorBefore: (id) => toQuery('cursorBefore', undefined, id),
        limit: (n) => toQuery('limit', undefined, n),
        offset: (n) => toQuery('offset', undefined, n),
        createdBefore: (v) => toQuery('createdBefore', undefined, v),
        createdAfter: (v) => toQuery('createdAfter', undefined, v),
        createdBetween: (s, e) => toQuery('createdBetween', undefined, [s, e]),
        updatedBefore: (v) => toQuery('updatedBefore', undefined, v),
        updatedAfter: (v) => toQuery('updatedAfter', undefined, v),
        updatedBetween: (s, e) => toQuery('updatedBetween', undefined, [s, e]),
        or: (qs) => JSON.stringify({ method: 'or', values: qs.map(q => JSON.parse(q)) }),
        and: (qs) => JSON.stringify({ method: 'and', values: qs.map(q => JSON.parse(q)) })
    };

    const ID = { unique: () => uniqueId(), custom: (id) => id };
    const Role = {
        any: () => 'any',
        users: (status = '') => status ? `users/${status}` : 'users',
        guests: () => 'guests',
        user: (id, status = '') => status ? `user:${id}/${status}` : `user:${id}`,
        team: (id, role = '') => role ? `team:${id}/${role}` : `team:${id}`,
        member: (id) => `member:${id}`,
        label: (name) => `label:${name}`
    };
    const Permission = {
        read: (r) => `read("${r}")`,
        write: (r) => `write("${r}")`,
        create: (r) => `create("${r}")`,
        update: (r) => `update("${r}")`,
        delete: (r) => `delete("${r}")`
    };

    class Client {
        constructor() { this.config = { endpoint: 'https://fake.appwrite/v1', project: 'fake', key: '', session: '', jwt: '' }; }
        setEndpoint(v) { this.config.endpoint = v; return this; }
        setEndpointRealtime(v) { this.config.endpointRealtime = v; return this; }
        setProject(v) { this.config.project = v; return this; }
        setKey(v) { this.config.key = v; return this; }
        setSession(v) { this.config.session = v; return this; }
        setJWT(v) { this.config.jwt = v; return this; }
        setLocale(v) { this.config.locale = v; return this; }
        setSelfSigned() { return this; }
        subscribe(channels, callback) {
            const id = `c${++subSeq}`;
            subscriptions.set(id, { channels: [].concat(channels), queries: [], callback });
            return () => subscriptions.delete(id);
        }
    }

    class TablesDB {
        constructor(client) { this.client = client; }
        listRows(f, ...r) { const p = params(f, r, ['databaseId', 'tableId', 'queries', 'transactionId', 'total']); return call('listRows', p, () => backend.listRows(p)); }
        getRow(f, ...r) { const p = params(f, r, ['databaseId', 'tableId', 'rowId', 'queries']); return call('getRow', p, () => backend.getRow(p)); }
        createRow(f, ...r) { const p = params(f, r, ['databaseId', 'tableId', 'rowId', 'data', 'permissions']); return call('createRow', p, () => backend.createRow(p)); }
        updateRow(f, ...r) { const p = params(f, r, ['databaseId', 'tableId', 'rowId', 'data', 'permissions']); return call('updateRow', p, () => backend.updateRow(p)); }
        upsertRow(f, ...r) { const p = params(f, r, ['databaseId', 'tableId', 'rowId', 'data', 'permissions']); return call('upsertRow', p, () => backend.upsertRow(p)); }
        deleteRow(f, ...r) { const p = params(f, r, ['databaseId', 'tableId', 'rowId']); return call('deleteRow', p, () => backend.deleteRow(p)); }
        incrementRowColumn(f, ...r) { const p = params(f, r, ['databaseId', 'tableId', 'rowId', 'column', 'value', 'max']); return call('incrementRowColumn', p, () => backend.incrementRowColumn(p)); }
        decrementRowColumn(f, ...r) { const p = params(f, r, ['databaseId', 'tableId', 'rowId', 'column', 'value', 'min']); return call('decrementRowColumn', p, () => backend.decrementRowColumn(p)); }
    }

    class Storage {
        constructor(client) { this.client = client; }
        listFiles(f, ...r) { const p = params(f, r, ['bucketId', 'queries', 'search']); return call('listFiles', p, () => backend.listFiles(p)); }
        getFile(f, ...r) {
            const p = params(f, r, ['bucketId', 'fileId']);
            return call('getFile', p, () => {
                const file = bucketOf(p.bucketId).rows.get(p.fileId);
                if (!file) fail(404, 'storage_file_not_found', 'The requested file could not be found.');
                return clone(file);
            });
        }
        createFile(f, ...r) { const p = params(f, r, ['bucketId', 'fileId', 'file', 'permissions']); return call('createFile', { ...p, file: undefined }, () => backend.createFile(p)); }
        deleteFile(f, ...r) { const p = params(f, r, ['bucketId', 'fileId']); return call('deleteFile', p, () => backend.deleteFile(p)); }
        fileUrl(kind, p) { return `${this.client?.config?.endpoint || 'https://fake.appwrite/v1'}/storage/buckets/${p.bucketId}/files/${p.fileId}/${kind}?project=${this.client?.config?.project || 'fake'}`; }
        getFileView(f, ...r) { return this.fileUrl('view', params(f, r, ['bucketId', 'fileId'])); }
        getFileDownload(f, ...r) { return this.fileUrl('download', params(f, r, ['bucketId', 'fileId'])); }
        getFilePreview(f, ...r) { return this.fileUrl('preview', params(f, r, ['bucketId', 'fileId'])); }
    }

    class Realtime {
        constructor(client) {
            this.client = client;
            this.pendingSubscribes = new Map();
        }
        async subscribe(channels, callback, queries = []) {
            const id = `s${++subSeq}`;
            subscriptions.set(id, { channels: [].concat(channels), queries: (queries || []).map(parse), callback });
            const unsubscribe = async () => { subscriptions.delete(id); };
            return {
                unsubscribe,
                close: unsubscribe,
                update: async (changes) => {
                    const sub = subscriptions.get(id);
                    if (!sub) return;
                    if (changes.channels) sub.channels = [].concat(changes.channels);
                    if (changes.queries) sub.queries = changes.queries.map(parse);
                }
            };
        }
        onError() {}
        onClose() {}
        onOpen() {}
        disconnect() {}
    }

    const unauthorized = () => fail(401, 'general_unauthorized_scope', 'User (role: guests) missing scopes (["account"])');
    class Account {
        constructor(client) { this.client = client; }
        get() { return call('account.get', {}, () => opts.user ? clone(opts.user) : unauthorized()); }
        getSession() { return call('account.getSession', {}, () => opts.user ? { $id: 'current', userId: opts.user.$id } : unauthorized()); }
        listSessions() { return call('account.listSessions', {}, () => ({ total: opts.user ? 1 : 0, sessions: opts.user ? [{ $id: 'current', userId: opts.user.$id }] : [] })); }
        deleteSession() { return call('account.deleteSession', {}, () => { opts.user = null; return {}; }); }
        listIdentities() { return call('account.listIdentities', {}, () => ({ total: 0, identities: [] })); }
        getPrefs() { return call('account.getPrefs', {}, () => clone(opts.user?.prefs || {})); }
    }
    class Teams {
        constructor(client) { this.client = client; }
        list() { return call('teams.list', {}, () => ({ total: opts.teams.length, teams: clone(opts.teams) })); }
        get(f, ...r) {
            const p = params(f, r, ['teamId']);
            return call('teams.get', p, () => {
                const team = opts.teams.find(t => t.$id === p.teamId);
                if (!team) fail(404, 'team_not_found', 'Team with the requested ID could not be found.');
                return clone(team);
            });
        }
        listMemberships() { return call('teams.listMemberships', {}, () => ({ total: 0, memberships: [] })); }
    }

    const sdk = { Client, TablesDB, Storage, Realtime, Account, Teams, Query, ID, Role, Permission, AppwriteException, __fake: true };

    // Seed
    function seedTable(databaseId, tableId, rows) {
        const table = tableOf(databaseId, tableId, true);
        for (const data of rows || []) {
            const id = data.$id || uniqueId();
            table.rows.set(id, makeRow(table, databaseId, tableId, id, data));
        }
        return table;
    }
    for (const [databaseId, tables] of Object.entries(opts.databases || {})) {
        for (const [tableId, rows] of Object.entries(tables || {})) seedTable(databaseId, tableId, rows);
    }
    for (const [bucketId, files] of Object.entries(opts.buckets || {})) {
        const bucket = bucketOf(bucketId, true);
        for (const f of files || []) {
            const id = f.$id || uniqueId();
            bucket.rows.set(id, { $createdAt: now(), $updatedAt: iso(clockMs), $permissions: [], name: id, mimeType: 'application/octet-stream', sizeOriginal: 0, ...f, $id: id, bucketId, $sequence: ++bucket.seq });
        }
    }

    // Writes land after the newest seeded row
    for (const store of [...[...databases.values()].flatMap(db => [...db.values()]), ...buckets.values()]) {
        for (const r of store.rows.values()) {
            const t = Date.parse(r.$updatedAt);
            if (t > clockMs) clockMs = t;
        }
    }

    // Test-side handle: act on the backend directly (as another user or the server)
    function table(databaseId, tableId) {
        if (tableId === undefined) {
            tableId = databaseId;
            const owners = [...databases.entries()].filter(([, t]) => t.has(tableId)).map(([d]) => d);
            if (owners.length !== 1) throw new Error(`fake: table "${tableId}" is ${owners.length ? 'in several databases; pass the database id' : 'not seeded'}`);
            databaseId = owners[0];
        }
        const base = { databaseId, tableId };
        return {
            rows: () => [...tableOf(databaseId, tableId).rows.values()].sort((a, b) => a.$sequence - b.$sequence).map(clone),
            get: (rowId) => backend.getRow({ ...base, rowId }),
            count: () => tableOf(databaseId, tableId).rows.size,
            insert: (data, rowId) => backend.createRow({ ...base, rowId: rowId || data?.$id, data }),
            update: (rowId, data) => backend.updateRow({ ...base, rowId, data }),
            remove: (rowId) => backend.deleteRow({ ...base, rowId }),
            seed: (rows) => { seedTable(databaseId, tableId, rows); },
            clear: () => { tableOf(databaseId, tableId).rows.clear(); }
        };
    }

    return {
        sdk,
        tablesDB: new TablesDB(new Client()),
        storage: new Storage(new Client()),
        backend,
        table,
        calls,
        // Queries of the latest list call, parsed, optionally for one table
        lastQueries(tableId) {
            for (let i = calls.length - 1; i >= 0; i--) {
                const c = calls[i];
                if (c.method === 'listRows' && (!tableId || c.params.tableId === tableId)) return (c.params.queries || []).map(parse);
            }
            return null;
        },
        failNext(method, error) { failures.push({ method, error }); },
        onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        subscriptions: () => [...subscriptions.values()].map(s => ({ channels: s.channels, queries: s.queries })),
        signIn(user, teams) { opts.user = user; if (teams) opts.teams = teams; },
        signOut() { opts.user = null; },
        install(target = globalThis) { target.Appwrite = sdk; return sdk; },
        options: opts
    };
}
