// Minimal in-memory IndexedDB double for happy-dom tests (open/upgrade,
// transactions with completion, get/put/delete/clear/getAll/getAllKeys).
// Databases outlive a "page load" so reload scenarios can be replayed; `delayMs`
// slows every request, `failPut` injects a quota-style error.
export function createIndexedDB() {
    const databases = new Map() // name -> { version, stores: Map<name, { keyPath, records: Map }> }
    const api = { opens: 0, delayMs: 0, failPut: null, databases }
    const later = (fn) => setTimeout(fn, api.delayMs)
    const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

    class Request {
        constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null }
    }

    class ObjectStore {
        constructor(tx, data) { this.tx = tx; this.data = data }
        get(key) { return this.tx._request(() => clone(this.data.records.get(key))) }
        getAll() { return this.tx._request(() => [...this.data.records.values()].map(clone)) }
        getAllKeys() { return this.tx._request(() => [...this.data.records.keys()]) }
        put(record) {
            return this.tx._request(() => {
                if (this.tx.mode !== 'readwrite') throw Object.assign(new Error('read only'), { name: 'ReadOnlyError' })
                const err = api.failPut?.(record)
                if (err) throw err
                const key = record[this.data.keyPath]
                this.data.records.set(key, clone(record))
                return key
            })
        }
        delete(key) { return this.tx._request(() => { this.data.records.delete(key) }) }
        clear() { return this.tx._request(() => { this.data.records.clear() }) }
    }

    class Transaction {
        constructor(db, mode) {
            this.db = db; this.mode = mode; this.error = null
            this.oncomplete = null; this.onerror = null; this.onabort = null
            this._pending = 0; this._done = false; this._aborted = false
        }
        objectStore(name) {
            const data = this.db._data.stores.get(name)
            if (!data) throw Object.assign(new Error(`no store ${name}`), { name: 'NotFoundError' })
            return new ObjectStore(this, data)
        }
        _request(exec) {
            const req = new Request()
            this._pending++
            later(() => {
                if (this._aborted) return
                try {
                    req.result = exec()
                } catch (e) {
                    req.error = e
                    this._pending--
                    req.onerror?.({ target: req })
                    this._abort(e)
                    return
                }
                this._pending--
                req.onsuccess?.({ target: req })
                this._maybeComplete()
            })
            return req
        }
        _abort(e) {
            if (this._done) return
            this._done = true; this._aborted = true; this.error = e
            later(() => { this.onerror?.({ target: this }); this.onabort?.({ target: this }) })
        }
        _maybeComplete() {
            if (this._pending !== 0 || this._done) return
            later(() => {
                if (this._pending === 0 && !this._done) { this._done = true; this.oncomplete?.({ target: this }) }
            })
        }
    }

    class Database {
        constructor(name, data) {
            this.name = name; this._data = data; this.onversionchange = null
            this.objectStoreNames = { contains: (n) => data.stores.has(n) }
        }
        createObjectStore(name, opts = {}) {
            const store = { keyPath: opts.keyPath, records: new Map() }
            this._data.stores.set(name, store)
            return store
        }
        transaction(_names, mode = 'readonly') { return new Transaction(this, mode) }
        close() {}
    }

    api.indexedDB = {
        open(name, version = 1) {
            api.opens++
            const req = new Request()
            req.onupgradeneeded = null
            later(() => {
                let data = databases.get(name)
                const isNew = !data
                if (isNew) { data = { version: 0, stores: new Map() }; databases.set(name, data) }
                const db = new Database(name, data)
                req.result = db
                if (isNew || version > data.version) { data.version = version; req.onupgradeneeded?.({ target: req }) }
                req.onsuccess?.({ target: req })
            })
            return req
        },
        deleteDatabase(name) {
            const req = new Request()
            later(() => { databases.delete(name); req.onsuccess?.({ target: req }) })
            return req
        }
    }

    // Test helpers: write/read the backing map directly
    api.seed = (dbName, record, storeName = 'sources') => {
        let data = databases.get(dbName)
        if (!data) { data = { version: 1, stores: new Map() }; databases.set(dbName, data) }
        let store = data.stores.get(storeName)
        if (!store) { store = { keyPath: 'key', records: new Map() }; data.stores.set(storeName, store) }
        store.records.set(record.key, clone(record))
    }
    api.records = (dbName, storeName = 'sources') => {
        const store = databases.get(dbName)?.stores.get(storeName)
        return store ? [...store.records.values()].map(clone) : []
    }
    api.reset = () => { databases.clear(); api.opens = 0; api.delayMs = 0; api.failPut = null }
    return api
}
