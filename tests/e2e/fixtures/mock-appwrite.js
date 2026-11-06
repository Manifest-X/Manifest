(function () {
  const N = Number(new URLSearchParams(location.search).get('rows') || 60);
  const store = window.__rows = Array.from({ length: N }, (_, i) => ({
    $id: 'r' + String(i + 1).padStart(5, '0'), name: 'Row ' + (i + 1), n: i + 1,
    status: i % 2 ? 'archived' : 'active',
    $createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), $updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString()
  }));
  const calls = window.__calls = [];
  window.__delay = () => 20;
  const subs = window.__subs = [];
  const q = (method, attribute, values) => JSON.stringify({ method, attribute, values: values === undefined ? undefined : (Array.isArray(values) ? values : [values]) });
  const Query = {
    equal: (a, v) => q('equal', a, v), notEqual: (a, v) => q('notEqual', a, v), lessThan: (a, v) => q('lessThan', a, v),
    lessThanEqual: (a, v) => q('lessThanEqual', a, v), greaterThan: (a, v) => q('greaterThan', a, v), greaterThanEqual: (a, v) => q('greaterThanEqual', a, v),
    contains: (a, v) => q('contains', a, v), startsWith: (a, v) => q('startsWith', a, v), endsWith: (a, v) => q('endsWith', a, v),
    between: (a, x, y) => q('between', a, [x, y]), isNull: a => q('isNull', a), isNotNull: a => q('isNotNull', a), search: (a, v) => q('search', a, v),
    orderAsc: a => q('orderAsc', a), orderDesc: a => q('orderDesc', a), orderRandom: () => q('orderRandom'),
    limit: n => q('limit', undefined, n), offset: n => q('offset', undefined, n), cursorAfter: id => q('cursorAfter', undefined, id), cursorBefore: id => q('cursorBefore', undefined, id),
    or: list => JSON.stringify({ method: 'or', values: list.map(s => JSON.parse(s)) }), and: list => JSON.stringify({ method: 'and', values: list.map(s => JSON.parse(s)) })
  };
  function match(row, Q) {
    const v = row[Q.attribute], vals = Q.values || [];
    switch (Q.method) {
      case 'equal': return vals.includes(v); case 'notEqual': return !vals.includes(v);
      case 'greaterThan': return v > vals[0]; case 'lessThan': return v < vals[0];
      case 'greaterThanEqual': return v >= vals[0]; case 'lessThanEqual': return v <= vals[0];
      case 'or': return Q.values.some(s => match(row, s)); case 'and': return Q.values.every(s => match(row, s));
      default: return true;
    }
  }
  function list(queries) {
    const Qs = (queries || []).map(s => JSON.parse(s));
    let rows = store.filter(r => Qs.every(Q => ['limit', 'offset', 'cursorAfter', 'cursorBefore', 'orderAsc', 'orderDesc', 'orderRandom'].includes(Q.method) || match(r, Q)));
    for (const Q of Qs) if (Q.method === 'orderAsc' || Q.method === 'orderDesc') { const d = Q.method === 'orderAsc' ? 1 : -1; rows = rows.slice().sort((a, b) => (a[Q.attribute] > b[Q.attribute] ? d : a[Q.attribute] < b[Q.attribute] ? -d : 0)); }
    const total = rows.length;
    const limits = Qs.filter(Q => Q.method === 'limit');
    const limit = limits.length ? limits[limits.length - 1].values[0] : 25;
    const off = Qs.find(Q => Q.method === 'offset'); const ca = Qs.find(Q => Q.method === 'cursorAfter'); const cb = Qs.find(Q => Q.method === 'cursorBefore');
    let start = off ? off.values[0] : 0;
    if (ca) start = rows.findIndex(r => r.$id === ca.values[0]) + 1;
    if (cb) { const e = rows.findIndex(r => r.$id === cb.values[0]); return { total, rows: rows.slice(Math.max(0, e - limit), e) }; }
    return { total: Math.min(total, 5000), rows: rows.slice(start, start + limit) };
  }
  const wait = (op, args) => new Promise(r => setTimeout(r, window.__delay(op, args)));
  const clone = o => JSON.parse(JSON.stringify(o));
  function emit(action, row) {
    const ev = `databases.main.tables.items.rows.${row.$id}.${action}`;
    for (const s of subs) if ([].concat(s.channel).some(c => c === 'databases.main.tables.items.rows')) setTimeout(() => s.cb({ events: [ev, 'databases.*.tables.*.rows.*.' + action], payload: clone(row) }), window.__rtDelay || 0);
  }
  window.__emit = emit;
  class Client { setEndpoint() { return this; } setProject() { return this; } setKey() { return this; } subscribe(ch, cb) { const s = { channel: ch, cb }; subs.push(s); return () => subs.splice(subs.indexOf(s), 1); } }
  class TablesDB {
    async listRows({ queries }) { if (window.__failReads > 0) { window.__failReads--; calls.push({ op: 'list:fail' }); await wait('list'); throw Object.assign(new Error('Service unavailable'), { code: 503 }); } calls.push({ op: 'list', queries: clone(queries || []), t: performance.now() }); const res = list(queries); await wait('list', queries); calls.push({ op: 'list:done', queries: clone(queries || []), t: performance.now() }); return clone(res); }
    async getRow({ rowId }) { calls.push({ op: 'get', rowId }); await wait('get'); return clone(store.find(r => r.$id === rowId)); }
    async createRow({ rowId, data }) { calls.push({ op: 'create', rowId }); const row = { ...data, $id: rowId || ('n' + Date.now()), $createdAt: new Date().toISOString(), $updatedAt: new Date().toISOString() }; store.push(row); emit('create', row); await wait('create'); if (window.__failWrites) throw Object.assign(new Error('mock fail'), { code: 500 }); return clone(row); }
    async updateRow({ rowId, data }) { calls.push({ op: 'update', rowId, data: clone(data || {}) }); await wait('update'); if (window.__failWrites) throw Object.assign(new Error('mock fail'), { code: 500 }); const row = store.find(r => r.$id === rowId); if (!row) throw Object.assign(new Error('not found'), { code: 404 }); Object.assign(row, data, { $updatedAt: new Date().toISOString() }); emit('update', row); return clone(row); }
    async deleteRow({ rowId }) { calls.push({ op: 'delete', rowId }); await wait('delete'); if (window.__failWrites) throw Object.assign(new Error('mock fail'), { code: 500 }); const i = store.findIndex(r => r.$id === rowId); const [row] = store.splice(i, 1); emit('delete', row); return {}; }
  }
  class Realtime { constructor() { } subscribe(channel, cb) { const s = { channel, cb }; subs.push(s); return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); }; } }
  window.Appwrite = { Client, TablesDB, Realtime, Query, ID: { unique: () => 'u' + Math.random().toString(36).slice(2, 10) }, Storage: null };
})();
