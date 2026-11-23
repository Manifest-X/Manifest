// Built SRI artifacts: every file the loader can inject has a hash matching the bytes
// it ships, and the loader carries its own version and the hash of the module map.
import { readFileSync, readdirSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = (f) => path.join(root, 'lib', f)
const sri = (buf) => `sha384-${createHash('sha384').update(buf).digest('base64')}`
const read = (f) => readFileSync(lib(f))
const src = readFileSync(path.join(root, 'src/scripts/manifest.js'), 'utf8')
const modulesJson = read('manifest.modules.integrity.json')
const modules = JSON.parse(modulesJson)
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version

const arr = (name) => new Function(`return ${src.match(new RegExp(`const ${name} = (\\[[^\\]]*\\])`))[1]}`)()
const loadable = () => {
    const names = new Set([...arr('AVAILABLE_PLUGINS'), ...arr('ALWAYS_ON'), ...arr('AUTHORING_PLUGINS'), ...arr('APPWRITE_PLUGINS'), ...arr('USAGE_LOADED_PLUGINS')])
    const extra = src.match(/const allPlugins = \[[^\]]*\]/)[0].match(/'([\w-]+)'/g).map((s) => s.slice(1, -1))
    extra.forEach((n) => names.add(n))
    // Aliases resolve to another module before loading
    const aliases = new Function(`return ${src.match(/const PLUGIN_ALIASES = (\{[^}]*\})/)[1]}`)()
    Object.keys(aliases).forEach((n) => names.delete(n))
    return [...names].map((n) => `manifest.${n.replace(/-/g, '.')}`)
}

describe('SRI build artifacts', () => {
    it('every browser script ships a minified sibling', () => {
        const js = readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js') && !f.endsWith('.min.js'))
        const missing = js.filter((f) => !readdirSync(path.join(root, 'lib')).includes(f.replace(/\.js$/, '.min.js')))
        expect(missing).toEqual([])
    })

    it('every module the loader can inject has a hash for both its .js and .min.js', () => {
        const missing = loadable().flatMap((b) => [`${b}.js`, `${b}.min.js`]).filter((f) => !modules[f])
        expect(missing).toEqual([])
    })

    it('every module hash matches the built bytes, and the map holds no loader entry', () => {
        const wrong = Object.entries(modules).filter(([f]) => !f.includes('@')).filter(([f, h]) => sri(read(f)) !== h).map(([f]) => f)
        expect(wrong).toEqual([])
        expect(modules['manifest.js']).toBeUndefined()
        expect(modules['manifest.min.js']).toBeUndefined()
        const scripts = readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js') && !/^manifest(\.min)?\.js$/.test(f))
        expect(scripts.filter((f) => !modules[f])).toEqual([])
    })

    it('the default Alpine has a hash matching the pinned package; once-default versions stay', () => {
        const v = src.match(/const DEFAULT_ALPINE_VERSION = '([^']+)'/)[1]
        const key = `alpinejs@${v}/dist/cdn.min.js`
        expect(modules[key]).toBe(sri(readFileSync(path.join(root, 'node_modules/alpinejs/dist/cdn.min.js'))))
        // Append-only: pages pinned with data-alpine to an earlier default keep verifying
        for (const old of ['3.17.5']) expect(modules[`alpinejs@${old}/dist/cdn.min.js`], old).toMatch(/^sha384-/)
    })

    it('every third-party file a plugin loads is pinned exactly and locked, with matching hashes', () => {
        const lock = JSON.parse(readFileSync(path.join(root, 'src/scripts/vendor.lock.json'), 'utf8'))
        const family = JSON.parse(read('manifest.vendor.integrity.json'))
        const plugins = readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js') && !f.endsWith('.min.js') && !/^manifest(\.sw|\.tailwind|\.utilities\.node)?\.js$/.test(f))
        const problems = []
        for (const f of plugins) {
            const code = read(f).toString('utf8')
            for (const m of code.matchAll(/ManifestVendor\.(?:script|fetch)\('([^']+)'(?:, '([^']+)')?\)/g)) {
                if (!lock[m[1]]) problems.push(`${f}: ${m[1]} not in vendor.lock.json`)
                if (m[2] && m[2] !== lock[m[1]]) problems.push(`${f}: ${m[1]} hash differs from the lock`)
            }
            // Every CDN URL left in plugin code names an exact version
            for (const m of code.matchAll(/https:\/\/(?:esm\.run|cdn\.jsdelivr\.net\/npm|unpkg\.com)\/((?:@[^/@'"`]+\/)?[^/@'"`]+)@([^/'"`]+)/g)) {
                if (!/^\d+\.\d+\.\d+$/.test(m[2])) problems.push(`${f}: ${m[1]}@${m[2]} is not an exact version`)
            }
            if (/import\(\s*['"`]https:/.test(code) && !/ManifestVendor\.checked/.test(code)) problems.push(`${f}: remote import() without a verified path`)
        }
        expect(problems).toEqual([])
        for (const [k, v] of Object.entries(lock)) {
            const inMap = /\/(languages|langs)\//.test(k) ? family[k] : modules[k]
            if (inMap !== v) problems.push(`${k} not carried into the integrity maps`)
        }
        expect(problems).toEqual([])
        expect(modules['manifest.vendor.integrity.json']).toBe(sri(read('manifest.vendor.integrity.json')))
        // The families plugins load by name exist in the lock
        expect(Object.keys(lock).some((k) => k.startsWith('@highlightjs/cdn-assets@11.11.1/languages/rust.min.js'))).toBe(true)
        expect(Object.keys(lock).some((k) => k.startsWith('i18n-iso-countries@7.14.0/langs/de.json'))).toBe(true)
        const umd = ['d3-array@3.2.5', 'd3-color@3.1.1', 'd3-format@3.1.3', 'd3-path@3.1.1', 'd3-time@3.1.1', 'd3-interpolate@3.0.2', 'd3-shape@3.2.1', 'd3-time-format@4.1.1', 'd3-scale@4.0.3', 'd3-geo@3.1.2', 'topojson-client@3.1.0']
        const charts = read('manifest.charts.js').toString('utf8')
        for (const spec of umd) {
            expect(charts.includes(`'${spec}'`), spec).toBe(true)
            expect(modules[`${spec}/dist/${spec.slice(0, spec.lastIndexOf('@'))}.min.js`], spec).toMatch(/^sha384-/)
        }
    })

    it('every minified script ships its source map', () => {
        const mins = readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.min.js'))
        const missing = mins.filter((f) => !read(f).toString('utf8').includes(`//# sourceMappingURL=${f}.map`) || !readdirSync(path.join(root, 'lib')).includes(`${f}.map`))
        expect(missing).toEqual([])
    })

    it('the built loaders embed their version and the module map hash', () => {
        for (const f of ['manifest.js', 'manifest.min.js']) {
            const code = read(f).toString('utf8')
            expect(/(['"])0\.0\.0-dev\1/.test(code), `${f} unstamped`).toBe(false)
            expect(code.includes(`'${version}'`) || code.includes(`"${version}"`), `${f} version`).toBe(true)
            expect(code.includes(sri(modulesJson)), `${f} map hash`).toBe(true)
        }
        expect(read('manifest.js').toString('utf8')).toContain(`const LOADER_VERSION = '${version}';`)
    })

    it('the source loader keeps the unstamped markers the build replaces', () => {
        expect(src).toContain("const LOADER_VERSION = '0.0.0-dev';")
        expect(src).toContain("const MODULES_INTEGRITY = '';")
    })

    it('manifest.integrity.json lists every browser file with its real hash', () => {
        const all = JSON.parse(read('manifest.integrity.json'))
        const files = readdirSync(path.join(root, 'lib')).filter((f) => /\.(js|css)$/.test(f))
        expect(files.filter((f) => all[f] !== sri(read(f)))).toEqual([])
        expect(all['manifest.modules.integrity.json']).toBe(sri(modulesJson))
    })
})
