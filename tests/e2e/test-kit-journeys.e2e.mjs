// mnfst-test journeys on the example app: green against fresh baselines, red on
// a planted framework regression (realtime deletes) and a planted CSS regression.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runJourneys } from '../../packages/test/browser.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const EXAMPLE = join(ROOT, 'packages/test/example')
const tmp = mkdtempSync(join(tmpdir(), 'mnfst-test-kit-'))
const config = (await import(join(EXAMPLE, 'journeys.mjs'))).default
const base = { ...config, root: EXAMPLE, mounts: { '/lib/': join(ROOT, 'lib') }, snapshots: join(tmp, 'shots'), log: null }

let failures = 0
const check = (label, cond, detail = '') => {
    console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : ` ${detail}`}`)
    if (!cond) failures++
}
const summary = (out) => out.results.map(r => `${r.name}: ${r.status}${r.error ? ` (${r.error})` : ''}`).join('; ')

try {
    const first = await runJourneys({ ...base, update: true })
    check('baselines written', first.ok, summary(first))
    const again = await runJourneys({ ...base, ci: true })
    check('green against baselines', again.ok, summary(again))

    const badLib = join(tmp, 'lib')
    cpSync(join(ROOT, 'lib'), badLib, { recursive: true })
    const file = join(badLib, 'manifest.appwrite.data.js')
    const src = readFileSync(file, 'utf8')
    const planted = src.replace("if (parts.includes('delete')) return 'delete';", "if (parts.includes('delete')) return 'update';")
    check('framework regression planted', planted !== src)
    writeFileSync(file, planted)
    const lib = await runJourneys({ ...base, ci: true, mounts: { '/lib/': badLib } })
    check('framework regression turns red', !lib.ok && lib.results.find(r => r.name === 'realtime from another user')?.status === 'fail', summary(lib))

    const badApp = join(tmp, 'app')
    cpSync(EXAMPLE, badApp, { recursive: true })
    const html = join(badApp, 'index.html')
    writeFileSync(html, readFileSync(html, 'utf8').replace('li { padding: .4rem 0;', 'li { padding: .5rem 0;'))
    const css = await runJourneys({ ...base, ci: true, root: badApp })
    const diffs = css.results.flatMap(r => r.snapshots).filter(s => s.status === 'fail')
    check('CSS regression turns red', !css.ok && diffs.length > 0, summary(css))
} finally {
    rmSync(tmp, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
