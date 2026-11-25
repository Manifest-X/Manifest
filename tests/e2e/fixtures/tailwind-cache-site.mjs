// Shared fixture for the Tailwind output cache e2e + bench: a realistic page
// (a few hundred Tailwind classes plus Manifest utilities) and a local server
// that plays the CDN (engine, Alpine) and the plugin base.
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const SPACE = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12]
const HUES = ['red', 'blue', 'green', 'slate', 'amber', 'violet']
const SHADES = [100, 300, 500, 700]

export function twClasses() {
    const out = []
    for (const p of ['p', 'px', 'py', 'm', 'mt', 'gap']) for (const s of SPACE) out.push(`${p}-${s}`)
    for (const k of ['bg', 'text', 'border']) for (const h of HUES) for (const s of SHADES) out.push(`${k}-${h}-${s}`)
    out.push('text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl', 'text-4xl')
    out.push('font-light', 'font-normal', 'font-medium', 'font-bold', 'font-black')
    out.push('leading-none', 'leading-tight', 'leading-snug', 'leading-normal', 'leading-loose')
    out.push('tracking-tight', 'tracking-normal', 'tracking-wide', 'tracking-widest')
    out.push('flex', 'grid', 'block', 'inline-flex', 'items-center', 'items-start', 'justify-between', 'justify-center')
    for (let i = 1; i <= 6; i++) out.push(`grid-cols-${i}`)
    out.push('w-full', 'w-1/2', 'w-1/3', 'w-64', 'h-12', 'h-32', 'min-h-screen', 'max-w-xl')
    out.push('rounded', 'rounded-md', 'rounded-lg', 'rounded-full', 'shadow', 'shadow-md', 'shadow-lg', 'border', 'border-2')
    out.push('opacity-50', 'opacity-75', 'overflow-hidden', 'truncate', 'underline', 'uppercase', 'italic')
    for (const h of HUES) out.push(`hover:bg-${h}-600`, `focus:ring-${h}-400`)
    out.push('md:flex', 'md:grid-cols-3', 'lg:p-8', 'lg:text-5xl', 'sm:hidden', 'dark:bg-slate-800', 'dark:text-white')
    out.push('focus:ring-2', 'w-[37px]', 'h-[13px]', 'bg-[#123456]', 'data-[state=open]:bg-red-500', 'group-hover:underline', 'group')
    out.push('transition', 'duration-200', 'ease-in-out', 'translate-x-1', 'rotate-3', 'scale-95', 'cursor-pointer', 'select-none')
    return out
}

export const MANIFEST_CLASSES = ['bg-surface-1', 'bg-surface-2', 'text-content-stark', 'text-content-subtle', 'bg-brand-surface', 'text-brand-content', 'border-line', 'bg-page']

export function pageHtml({ tailwind = true, extraHead = '', body, classes, title = 'x', loaderAttrs = '' } = {}) {
    const cls = classes || twClasses()
    const cards = body ?? (() => {
        const rows = []
        for (let i = 0; i < cls.length; i += 6) {
            const chunk = cls.slice(i, i + 6).join(' ')
            const m = MANIFEST_CLASSES[(i / 6) % MANIFEST_CLASSES.length]
            rows.push(`<div class="card ${chunk}"><span class="${m}">Card ${i / 6}</span><p class="author-thing">copy</p></div>`)
        }
        return rows.join('\n')
    })()
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/fw/manifest.css">
${extraHead}
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="utilities,color" data-cdn="${'/cdn'}" data-alpine="/alpine.js"${tailwind ? ' data-tailwind' : ''}${loaderAttrs}></script></head>
<body x-data>
<div id="probe-w" class="w-[37px] h-[13px] bg-[#123456]"></div>
<div id="probe-hover" class="hover:bg-red-600 md:flex dark:bg-slate-800 data-[state=open]:bg-red-500 p-4" data-state="open"></div>
<div id="probe-m" class="bg-brand-surface p-2"></div>
${cards}
</body></html>`
}

// pages: { '/path': html | () => html }. Engine requests are counted.
export function serve({ libDir = path.join(ROOT, 'lib'), pages, delayEngineMs = 0 }) {
    const counts = { engine: 0 }
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        const send = (file, type) => {
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' })
            res.end(fs.readFileSync(file))
        }
        const type = p.endsWith('.css') ? 'text/css' : 'text/javascript'
        if (p.startsWith('/fw/')) return send(path.join(libDir, p.slice(4)), type)
        if (p.startsWith('/cdn/')) {
            const file = p.split('/lib/')[1]
            if (/tailwind/.test(p)) {
                counts.engine++
                if (delayEngineMs) return setTimeout(() => send(path.join(libDir, file), type), delayEngineMs)
            }
            return send(path.join(libDir, file), type)
        }
        if (p === '/alpine.js') return send(path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js'), type)
        const page = pages[p]
        if (!page) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' })
        res.end(typeof page === 'function' ? page() : page)
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
        port: server.address().port,
        counts,
        close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) })
    })))
}

export { ROOT }

// Minimal page with markup before/after the loader tag (cascade and block-order cases)
export function sitePage({ before = '', after = '', body = '', plugins = 'utilities,color', loaderAttrs = '', manifestCss = true } = {}) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
${manifestCss ? '<link rel="stylesheet" href="/fw/manifest.css">' : ''}
${before}
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="${plugins}" data-cdn="/cdn" data-alpine="/alpine.js" data-tailwind${loaderAttrs}></script>
${after}
</head><body x-data>${body}<div id="probe-w" class="w-[37px]"></div></body></html>`
}
