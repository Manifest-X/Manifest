/**
 * ManifestDataLoaders.fetchText shares CSV text only while the loader's boot is in
 * progress: until manifest:ready, and never when the data module loads after it
 * or without the loader.
 */
import vm from 'vm'
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.resolve(__dirname, '../src/scripts/data/core/manifest.data.loaders.js'), 'utf8')

function load(flags = {}, status = () => 200) {
    const listeners = {}
    const requests = []
    const window = {
        ...flags,
        location: { href: 'http://x/' },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn) },
        dispatch(type) { (listeners[type] || []).forEach((fn) => fn()) }
    }
    const fetch = async (url) => { requests.push(url); const code = status(); return { ok: code < 400, status: code, text: async () => 'key,en\nhello,Hello\n' } }
    const ctx = { window, fetch, document: { querySelector: () => null }, URL, Promise, Map, Set, console }
    vm.createContext(ctx)
    vm.runInContext(source, ctx)
    return { window, requests, fetchText: (u) => window.ManifestDataLoaders.fetchText(u) }
}

describe('fetchText boot sharing', () => {
    it('shares one request per file while the boot is in progress, then stops at manifest:ready', async () => {
        const env = load({ __manifestLoaderStarted: true })
        await Promise.all([env.fetchText('/a.csv'), env.fetchText('/a.csv'), env.fetchText('http://x/a.csv')])
        expect(env.requests).toEqual(['/a.csv'])
        env.window.dispatch('manifest:ready')
        await env.fetchText('/a.csv')
        await env.fetchText('/a.csv')
        expect(env.requests).toHaveLength(3)
    })

    it('never shares when the data module loads after manifest:ready', async () => {
        const env = load({ __manifestLoaderStarted: true, __manifestReady: true })
        await env.fetchText('/a.csv')
        await env.fetchText('/a.csv')
        expect(env.requests).toHaveLength(2)
    })

    it('never shares without the loader', async () => {
        const env = load()
        await env.fetchText('/a.csv')
        await env.fetchText('/a.csv')
        expect(env.requests).toHaveLength(2)
    })

    it('drops a failed response so the next read retries', async () => {
        let code = 404
        const env = load({ __manifestLoaderStarted: true }, () => code)
        expect((await env.fetchText('/a.csv')).ok).toBe(false)
        code = 200
        expect((await env.fetchText('/a.csv')).text).toContain('Hello')
        await env.fetchText('/a.csv')
        expect(env.requests).toHaveLength(2)
    })
})
