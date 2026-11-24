// Edit depends on Rich Text: EDIT_SRC evaluates Rich Text once per window, then Edit.
// Evaluating it again (a simulated reload) re-runs Edit only. EDIT_ONLY_SRC is Edit alone.
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(path.join(dir, '../../src/scripts', f), 'utf8')

// The bundle must be the build of the subscripts as they are now: a stale or swapped bundle
// (no rebuild, another checkout's file) would test other code and pass or fail for nothing.
function editBundle() {
    const src = read('manifest.edit.js')
    const list = /editSubscripts:\s*\[([\s\S]*?)\]/.exec(read('build.mjs'))[1].match(/'[^']+'/g).map(x => x.slice(1, -1))
    const built = `/* manifest.edit.js — built from scripts/edit/ */\n\n(function () {\n\n${list.map(f => read('edit/' + f)).join('\n\n')}\n\n})();\n`
    if (src !== built) throw new Error('src/scripts/manifest.edit.js is not the build of src/scripts/edit/*: run npm run build')
    return src
}
export const EDIT_ONLY_SRC = editBundle()
export const RICH_SRC = read('manifest.rich.text.js')
export const EDIT_SRC = `if (!window.ManifestRichText) {\n${RICH_SRC}\n}\nif (typeof document.execCommand !== 'function') document.execCommand = () => true;\n${EDIT_ONLY_SRC}`
