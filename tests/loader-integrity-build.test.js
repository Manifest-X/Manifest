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
        const wrong = Object.entries(modules).filter(([f]) => !f.startsWith('alpinejs@')).filter(([f, h]) => sri(read(f)) !== h).map(([f]) => f)
        expect(wrong).toEqual([])
        expect(modules['manifest.js']).toBeUndefined()
        expect(modules['manifest.min.js']).toBeUndefined()
        const scripts = readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js') && !/^manifest(\.min)?\.js$/.test(f))
        expect(scripts.filter((f) => !modules[f])).toEqual([])
    })

    it('the default Alpine has a hash matching the pinned package', () => {
        const v = src.match(/const DEFAULT_ALPINE_VERSION = '([^']+)'/)[1]
        const key = `alpinejs@${v}/dist/cdn.min.js`
        expect(modules[key]).toBe(sri(readFileSync(path.join(root, 'node_modules/alpinejs/dist/cdn.min.js'))))
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
