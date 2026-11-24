// manifest.schema.json accepts real manifests and the scope values the data layer supports
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => JSON.parse(readFileSync(path.join(root, p), 'utf8'))

const schema = read('src/scripts/manifest.schema.json')
const validate = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(schema)

const fixtureDir = 'tests/fixtures/manifests'
const samples = [
    'src/manifest.json',
    'templates/starter/manifest.json',
    'templates/docs/manifest.json',
    ...readdirSync(path.join(root, fixtureDir)).filter(f => f.endsWith('.json')).map(f => `${fixtureDir}/${f}`)
]

const withScope = scope => ({ data: { projects: { appwriteDatabaseId: 'db', appwriteTableId: 't', scope } } })

describe('manifest.schema.json', () => {
    it.each(samples)('validates %s', file => {
        const ok = validate(read(file))
        expect(validate.errors ?? [], file).toEqual([])
        expect(ok).toBe(true)
    })

    it.each(['user', 'team', 'teams'])('accepts scope "%s"', scope => {
        expect(validate(withScope(scope))).toBe(true)
        expect(validate(withScope([scope]))).toBe(true)
    })

    it('accepts dual scopes', () => {
        expect(validate(withScope(['user', 'team']))).toBe(true)
        expect(validate(withScope(['user', 'teams']))).toBe(true)
    })

    it('rejects unknown scopes', () => {
        expect(validate(withScope('everyone'))).toBe(false)
        expect(validate(withScope(['user', 'org']))).toBe(false)
    })

    it('lib copy matches src', () => {
        expect(read('lib/manifest.schema.json')).toEqual(schema)
    })
})
