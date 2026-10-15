// Edit depends on Rich Text: EDIT_SRC evaluates Rich Text once per window, then Edit.
// Evaluating it again (a simulated reload) re-runs Edit only. EDIT_ONLY_SRC is Edit alone.
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(path.join(dir, '../../src/scripts', f), 'utf8')

export const EDIT_ONLY_SRC = read('manifest.edit.js')
export const RICH_SRC = read('manifest.rich.text.js')
export const EDIT_SRC = `if (!window.ManifestRichText) {\n${RICH_SRC}\n}\nif (typeof document.execCommand !== 'function') document.execCommand = () => true;\n${EDIT_ONLY_SRC}`
