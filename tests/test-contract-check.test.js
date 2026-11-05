/**
 * mnfst-test `contract` check: manifest.json Appwrite sources must name tables,
 * scope columns and query columns the shared contract declares.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/test/bin/mnfst-test.js')
const CONTRACT = `export const tables = {
  tasks: { database: 'main', id: 'tasks', columns: ['title', 'status', 'workspaceId', 'author'] },
  notes: { id: 'notes' }
}
export const limits = { titleMax: 80 }
`

let dir
const write = (f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c) }
function lint(manifest) {
    write('manifest.json', JSON.stringify({ name: 't', short_name: 't', ...manifest }))
    const r = spawnSync(process.execPath, [CLI, '--only', 'static', '--json', '--root', dir], { encoding: 'utf8' })
    const out = JSON.parse(r.stdout)
    return out.checks.find((c) => c.name === 'contract')
}
const errors = (c) => c.issues.filter((i) => i.severity === 'error').map((i) => i.message)

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-contract-'))
    write('index.html', '<!doctype html><html><head><title>t</title></head><body></body></html>')
    write('shared/contract.js', CONTRACT)
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('contract check', () => {
    it('is quiet without a contract', () => {
        const c = lint({ data: { tasks: { appwriteTableId: 'tasks' } } })
        expect(errors(c)).toEqual([])
        expect(c.details).toBe('no contract declared')
    })

    it('passes sources that match the contract', () => {
        const c = lint({
            contract: '/shared/contract.js',
            data: {
                tasks: {
                    appwriteDatabaseId: 'main', appwriteTableId: 'tasks', scope: 'team', scopeColumn: 'workspaceId',
                    queries: { default: [['equal', 'status', 'open'], ['orderDesc', '$createdAt'], ['limit', 50]], mine: [['or', [['equal', 'author.name', 'a'], ['isNull', 'title']]], ['select', ['title', 'status']]] }
                },
                notes: { appwriteTableId: 'notes', queries: [['equal', 'anything', 1]] },
                local: '/data/x.json'
            }
        })
        expect(errors(c)).toEqual([])
        expect(c.details).toBe('2 table(s) declared, 2 Appwrite source(s) checked')
    })

    it('flags an undeclared table, a wrong database, a scope column and query columns', () => {
        const c = lint({
            contract: '/shared/contract.js',
            data: {
                chats: { appwriteTableId: 'chats' },
                other: { appwriteDatabaseId: 'archive', appwriteTableId: 'tasks' },
                tasks: { appwriteDatabaseId: 'main', appwriteTableId: 'tasks', scopeColumn: { team: 'workspaceID' }, queries: [['equal', 'stauts', 'open'], ['and', [['greaterThan', 'due', 1]]], ['select', ['title', 'body']]] }
            }
        })
        expect(errors(c)).toEqual([
            'Data source "chats" reads table "chats", which the contract does not declare',
            'Data source "other" reads table "tasks" in "archive", which the contract does not declare',
            'Data source "tasks" scopes on "workspaceID", not a column of "tasks" in the contract',
            'Data source "tasks" reads "stauts", not a column of "tasks" in the contract',
            'Data source "tasks" reads "due", not a column of "tasks" in the contract',
            'Data source "tasks" reads "body", not a column of "tasks" in the contract'
        ])
    })

    it('accepts the object form', () => {
        const c = lint({ contract: { module: '/shared/contract.js', checks: ['*-staging.example.com'] }, data: { tasks: { appwriteDatabaseId: 'main', appwriteTableId: 'tasks', queries: [['equal', 'nope', 1]] } } })
        expect(errors(c)).toEqual(['Data source "tasks" reads "nope", not a column of "tasks" in the contract'])
    })

    it('checks the default scope columns when none is named', () => {
        const c = lint({ contract: '/shared/contract.js', data: { tasks: { appwriteDatabaseId: 'main', appwriteTableId: 'tasks', scope: ['user', 'team'], scopeColumn: { team: 'workspaceId' } } } })
        expect(errors(c)).toEqual(['Data source "tasks" scopes on "userId", not a column of "tasks" in the contract'])
    })

    it('uses the manifest-wide Appwrite database when a source names none', () => {
        const c = lint({ contract: '/shared/contract.js', appwrite: { databaseId: 'archive' }, data: { tasks: { appwriteTableId: 'tasks' } } })
        expect(errors(c)).toEqual(['Data source "tasks" reads table "tasks" in "archive", which the contract does not declare'])
    })

    it('reports a missing or broken contract module', () => {
        expect(errors(lint({ contract: '/shared/nope.js' }))).toEqual(['contract module not found: /shared/nope.js'])
        write('shared/contract.js', 'export const tables = {')
        expect(errors(lint({ contract: '/shared/contract.js' }))[0]).toMatch(/^contract module failed to load/)
    })
})
