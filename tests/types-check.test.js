/**
 * Type checks without a build: tests/fixtures/types-app (JSDoc app modules,
 * shared contract, generated manifest.d.ts) passes `tsc --noEmit -p
 * jsconfig.json`, and each planted mistake fails it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'types-app')
const TSC = path.join(ROOT, 'node_modules', '.bin', 'tsc')
const TYPES = path.join(ROOT, 'packages', 'types', 'bin', 'mnfst-types.js')

let dir
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8')
const write = (f, c) => fs.writeFileSync(path.join(dir, f), c)
const tsc = () => spawnSync(TSC, ['-p', 'jsconfig.json'], { cwd: dir, encoding: 'utf8' })
const types = (...args) => spawnSync(process.execPath, [TYPES, ...args], { cwd: dir, encoding: 'utf8' })

function planted(file, from, to) {
    const original = read(file)
    expect(original.includes(from), `${file} contains ${from}`).toBe(true)
    write(file, original.replace(from, to))
    try { return tsc() } finally { write(file, original) }
}

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-types-app-'))
    fs.cpSync(FIXTURE, dir, { recursive: true })
})
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('types-app', () => {
    it('committed manifest.d.ts matches manifest.json, the contract and the template', () => {
        const r = types('--check')
        expect(r.stdout + r.stderr).toContain('up to date')
        expect(r.status).toBe(0)
    })

    it('type-checks clean', () => {
        const r = tsc()
        expect(r.stdout + r.stderr).toBe('')
        expect(r.status).toBe(0)
    })

    const COMPONENT = 'app/components/task-list.js'
    const cases = [
        ['a wrong field on a typed row', COMPONENT, "t.status === 'open'", "t.stauts === 'open'", "Property 'stauts' does not exist"],
        ['a wrong field on a contract-columns row', COMPONENT, 'w => w.name', 'w => w.nmae', "Property 'nmae' does not exist"],
        ['a wrong field on a local JSON source', COMPONENT, "m.role === 'lead'", "m.rol === 'lead'", "Property 'rol' does not exist"],
        ['a wrong query column', COMPONENT, "['equal', 'status', 'open']", "['equal', 'stauts', 'open']", 'stauts'],
        ['a wrong $search field', COMPONENT, "$search(this.query, 'title')", "$search(this.query, 'titel')", 'task-list.js(9,'],
        ['a wrong source name', COMPONENT, 'this.$x.workspaces', 'this.$x.workspace', "Property 'workspace' does not exist"],
        ['a wrong $first argument', COMPONENT, '$first(20)', "$first('20')", "Argument of type 'string' is not assignable to parameter of type 'number'"],
        ['a missing $update argument', COMPONENT, "$update(id, { status: 'done' })", '$update(id)', "Argument of type 'string' is not assignable to parameter of type '{ id?: string"],
        ['a value outside the column type', COMPONENT, "$update(id, { status: 'done' })", "$update(id, { status: 'finished' })", `Type '"finished"' is not assignable to type 'Status'`],
        ['a wrong $toast argument', COMPONENT, '$toast.positive(`Added ${task.title}`)', '$toast.positive(42)', "Argument of type 'number' is not assignable to parameter of type 'string'"],
        ['a wrong store property', COMPONENT, 'this.$store.session.summary', 'this.$store.session.sumary', "Property 'sumary' does not exist"],
        ['a missing $saving argument', COMPONENT, '$saving(id)', '$saving()', 'Expected 1 arguments, but got 0'],
        ['$more treated as a flag', COMPONENT, 'await this.$x.tasks.$more()', 'this.$x.tasks.$more = true', "is not assignable to type '() => Promise<number>'"],
        ['a wrong field read from the contract', COMPONENT, "validateTask({ title: this.title, status: 'open' })", "validateTask({ titel: this.title, status: 'open' })", 'titel']
    ]
    for (const [name, file, from, to, message] of cases) {
        it(`fails on ${name}`, () => {
            const r = planted(file, from, to)
            expect(r.status).not.toBe(0)
            expect(r.stdout).toContain(message)
        })
    }

    it('--check fails when manifest.json changes without regenerating', () => {
        const original = read('manifest.json')
        const m = JSON.parse(original)
        m.data.notes = { appwriteTableId: 'notes' }
        write('manifest.json', JSON.stringify(m))
        try {
            const r = types('--check')
            expect(r.status).toBe(1)
            expect(r.stderr).toContain('out of date')
        } finally { write('manifest.json', original) }
    })
})

describe('starter template', () => {
    const STARTER = path.join(ROOT, 'templates', 'starter')
    it('committed manifest.d.ts is current and the starter type-checks clean', () => {
        const check = spawnSync(process.execPath, [TYPES, '--check'], { cwd: STARTER, encoding: 'utf8' })
        expect(check.status, check.stderr).toBe(0)
        const r = spawnSync(TSC, ['-p', 'jsconfig.json'], { cwd: STARTER, encoding: 'utf8' })
        expect(r.stdout + r.stderr).toBe('')
        expect(r.status).toBe(0)
    })
})
