/**
 * Type checks without a build: tests/fixtures/types-app (JSDoc app modules,
 * a typed shared module, generated manifest.d.ts) passes `tsc --noEmit -p
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
const types = (...args) => spawnSync(process.execPath, [TYPES, ...args], { cwd: dir, encoding: 'utf8' })
const tsc = () => types('--tsc')

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
    it('committed manifest.d.ts matches manifest.json and the template', () => {
        const r = types('--check')
        expect(r.stdout + r.stderr).toContain('up to date')
        expect(r.status).toBe(0)
    })

    it('type-checks clean', () => {
        const r = tsc()
        expect(r.stdout).toContain('no type errors')
        expect(r.stdout.replace('mnfst-types: no type errors', '').trim() + r.stderr).toBe('')
        expect(r.status).toBe(0)
    })

    const COMPONENT = 'app/components/task-list.js'
    const cases = [
        ['a wrong field on a typed row', COMPONENT, "t.status === 'open'", "t.stauts === 'open'", "Property 'stauts' does not exist"],
        ['a wrong field on a local JSON source', COMPONENT, "m.role === 'lead'", "m.rol === 'lead'", "Property 'rol' does not exist"],
        ['a wrong query column', COMPONENT, "['equal', 'status', 'open']", "['equal', 'stauts', 'open']", 'stauts'],
        ['a wrong $search field', COMPONENT, "$search(this.query, 'title')", "$search(this.query, 'titel')", 'task-list.js(9,'],
        ['a wrong $first argument', COMPONENT, '$first(20)', "$first('20')", "Argument of type 'string' is not assignable to parameter of type 'number'"],
        ['a missing $update argument', COMPONENT, "$update(id, { status: 'done' })", '$update(id)', 'Expected 2 arguments, but got 1'],
        ['a value outside the column type', COMPONENT, "$update(id, { status: 'done' })", "$update(id, { status: 'finished' })", `Type '"finished"' is not assignable to type 'Status'`],
        ['a wrong $toast argument', COMPONENT, '$toast.positive(`Added ${task.title}`)', '$toast.positive(42)', "Argument of type 'number' is not assignable to parameter of type 'string'"],
        ['a wrong store property', COMPONENT, 'this.$store.session.summary', 'this.$store.session.sumary', "Property 'sumary' does not exist"],
        ['a missing $saving argument', COMPONENT, '$saving(id)', '$saving()', 'Expected 1 arguments, but got 0'],
        ['$more treated as a flag', COMPONENT, 'await this.$x.tasks.$more()', 'this.$x.tasks.$more = true', "is not assignable to type '() => Promise<number>'"],
        ['$reload with an argument', 'app/components/valid-usage.js', 'this.$x.team.$reload()', 'this.$x.team.$reload(true)', 'Expected 0 arguments, but got 1'],
        ['a wrong field passed to a typed helper', COMPONENT, "validateTask({ title: this.title, status: 'open' })", "validateTask({ titel: this.title, status: 'open' })", 'titel']
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

describe('import map drift', () => {
    const IMPORT = "import { component } from '@app/lib/component.js'"
    const MAP = '"@shared/": "/shared/"'
    let original
    beforeAll(() => {
        original = { index: read('index.html'), comp: read('app/components/task-list.js'), jsconfig: read('jsconfig.json') }
        write('index.html', original.index.replace(MAP, MAP + ', "@lib/": "/app/lib/"'))
        write('app/components/task-list.js', original.comp.replace(IMPORT, "import { component } from '@lib/component.js'"))
    })
    afterAll(() => {
        write('index.html', original.index)
        write('app/components/task-list.js', original.comp)
        write('jsconfig.json', original.jsconfig)
    })

    it('a hand-written jsconfig without the new alias breaks plain tsc', () => {
        const r = spawnSync(TSC, ['-p', 'jsconfig.json'], { cwd: dir, encoding: 'utf8' })
        expect(r.status).not.toBe(0)
        expect(r.stdout).toContain("'@lib/component.js'")
    })

    it('--tsc merges the new alias into the hand-written jsconfig', () => {
        const r = tsc()
        expect(r.stdout).toContain('no type errors')
        expect(r.status).toBe(0)
    })

    it('--tsc works with no jsconfig at all', () => {
        fs.rmSync(path.join(dir, 'jsconfig.json'))
        try {
            const r = tsc()
            expect(r.stdout).toContain('no type errors')
            expect(r.status).toBe(0)
        } finally { write('jsconfig.json', original.jsconfig) }
    })

    it('--init adds the missing alias to an existing jsconfig', () => {
        const r = types('--init')
        expect(r.stdout).toContain('added @lib/*')
        expect(JSON.parse(read('jsconfig.json')).compilerOptions.paths['@lib/*']).toEqual(['./app/lib/*'])
        expect(spawnSync(TSC, ['-p', 'jsconfig.json'], { cwd: dir, encoding: 'utf8' }).status).toBe(0)
    })
})

describe('hand-written config', () => {
    it("--tsc keeps the project's own compiler options", () => {
        const original = { jsconfig: read('jsconfig.json'), comp: read('app/components/task-list.js') }
        const config = JSON.parse(original.jsconfig)
        config.compilerOptions.noUnusedLocals = true
        write('jsconfig.json', '// project settings\n' + JSON.stringify(config, null, 2))
        write('app/components/task-list.js', original.comp.replace("import { validateTask } from '@shared/model.js'", "import { validateTask } from '@shared/model.js'\nconst unused = 1"))
        try {
            const r = tsc()
            expect(r.status).not.toBe(0)
            expect(r.stdout).toContain("'unused' is declared but its value is never read")
        } finally {
            write('jsconfig.json', original.jsconfig)
            write('app/components/task-list.js', original.comp)
        }
    })
})

describe('extended configs', () => {
    it("--tsc and --init keep a base config's paths and include", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-types-extends-'))
        try {
            fs.cpSync(FIXTURE, tmp, { recursive: true })
            const own = JSON.parse(fs.readFileSync(path.join(tmp, 'jsconfig.json'), 'utf8'))
            own.compilerOptions.paths['~lib/*'] = ['./app/lib/*']
            fs.writeFileSync(path.join(tmp, 'base.json'), JSON.stringify(own, null, 2))
            fs.writeFileSync(path.join(tmp, 'jsconfig.json'), JSON.stringify({ extends: './base.json' }, null, 2))
            fs.writeFileSync(path.join(tmp, 'app', 'use.js'), "import { component } from '~lib/component.js'\nexport const c = component\n")
            const run = (...args) => spawnSync(process.execPath, [TYPES, ...args], { cwd: tmp, encoding: 'utf8' })
            const r = run('--tsc')
            expect(r.stdout).toContain('no type errors')

            const html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8')
            fs.writeFileSync(path.join(tmp, 'index.html'), html.replace('"@shared/": "/shared/"', '"@shared/": "/shared/", "@lib/": "/app/lib/"'))
            expect(run('--init').stdout).toContain('added @lib/*')
            const child = JSON.parse(fs.readFileSync(path.join(tmp, 'jsconfig.json'), 'utf8'))
            expect(child.compilerOptions.paths['~lib/*']).toEqual(['./app/lib/*'])
            expect(child.compilerOptions.paths['@lib/*']).toEqual(['./app/lib/*'])
            expect(spawnSync(TSC, ['-p', 'jsconfig.json'], { cwd: tmp, encoding: 'utf8' }).status).toBe(0)
        } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    })

    it("--init adds aliases when the child's own paths hide the base's", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-types-hide-'))
        try {
            fs.cpSync(FIXTURE, tmp, { recursive: true })
            fs.renameSync(path.join(tmp, 'jsconfig.json'), path.join(tmp, 'base.json'))
            fs.writeFileSync(path.join(tmp, 'jsconfig.json'), JSON.stringify({ extends: './base.json', compilerOptions: { paths: { 'x/*': ['./app/*'] } } }, null, 2))
            const r = spawnSync(process.execPath, [TYPES, '--init'], { cwd: tmp, encoding: 'utf8' })
            expect(r.stdout).toContain('added mnfst, @app/*, @shared/*')
            expect(spawnSync(TSC, ['-p', 'jsconfig.json'], { cwd: tmp, encoding: 'utf8' }).status).toBe(0)
        } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    })

    it('--check --tsc runs both', () => {
        const original = read('manifest.json')
        const m = JSON.parse(original)
        m.data.notes = { appwriteTableId: 'notes' }
        write('manifest.json', JSON.stringify(m))
        try {
            const r = types('--check', '--tsc')
            expect(r.status).toBe(1)
            expect(r.stderr).toContain('out of date')
            expect(r.stdout).toContain('no type errors')
        } finally { write('manifest.json', original) }
    })
})

describe('no assumed layout', () => {
    it('checks the scripts the page loads, under any folder and alias names, and nothing else', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-types-layout-'))
        const put = (f, c) => { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), c) }
        try {
            put('manifest.json', JSON.stringify({ name: 'x', preloadedComponents: ['parts/panel.html'], data: { team: '/records/team.json' } }))
            put('records/team.json', JSON.stringify([{ id: 'a', name: 'Ada' }]))
            put('index.html', '<script type="importmap">{ "imports": { "#kit/": "/code/kit/" } }</script><script src="https://cdn.example.com/x.js"></script><script type="module" src="/code/boot.js"></script>')
            put('parts/panel.html', '<div></div><script src="../code/panel.js"></script>')
            put('code/boot.js', "import { label } from '#kit/label.js'\nexport const s = label('a')\n")
            put('code/kit/label.js', '/** @param {string} s */\nexport const label = (s) => s.toUpperCase()\n')
            put('code/panel.js', 'export const n = 1\n')
            put('tools/build.mjs', "const fs = require('fs'); process.exit(undefinedThing)\n")
            const run = (...args) => spawnSync(process.execPath, [TYPES, ...args], { cwd: tmp, encoding: 'utf8' })
            expect(run().status).toBe(0)
            const ok = run('--tsc')
            expect(ok.stdout).toContain('no type errors')
            put('code/boot.js', "import { label } from '#kit/label.js'\nexport const s = label(42)\n")
            put('code/panel.js', 'export const n = missingName\n')
            const bad = run('--tsc')
            expect(bad.status).not.toBe(0)
            expect(bad.stdout).toContain('code/boot.js')
            expect(bad.stdout).toContain('code/panel.js')
            expect(bad.stdout).not.toContain('tools/build.mjs')
        } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    })

    it('a page that loads no local scripts has nothing to check', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-types-empty-'))
        try {
            fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ name: 'x' }))
            fs.writeFileSync(path.join(tmp, 'index.html'), '<script src="https://cdn.example.com/x.js"></script>')
            const r = spawnSync(process.execPath, [TYPES, '--tsc'], { cwd: tmp, encoding: 'utf8' })
            expect(r.status).toBe(0)
            expect(r.stdout).toContain('no local scripts or .d.ts files to check')
        } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    })
})
