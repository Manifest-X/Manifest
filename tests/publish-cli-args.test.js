/**
 * mnfst-publish refuses unknown options (a bare publish defaults to production),
 * answers --version/--help without publishing, lists deployments, and carries
 * server refusal codes into --json.
 */
import { describe, it, expect } from 'vitest'
import { parseArgs, runPromote, listSummary, packageVersion, codedError, jsonFailure } from '../packages/publish/manifest.publish.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = fileURLToPath(new URL('../packages/publish/bin/mnfst-publish.js', import.meta.url))
const PKG = JSON.parse(readFileSync(new URL('../packages/publish/package.json', import.meta.url), 'utf8'))

// A project folder with a key and an unreachable server: anything that got past
// parsing would fail on the network instead, with a different message.
function run(args) {
    const root = mkdtempSync(join(tmpdir(), 'mnfst-publish-args-'))
    writeFileSync(join(root, 'manifest.json'), '{}')
    writeFileSync(join(root, 'index.html'), '<h1>x</h1>')
    const r = spawnSync(process.execPath, [BIN, ...args, '--key', 'k', '--mcp', 'http://127.0.0.1:9/mcp', '--root', root], { encoding: 'utf8', timeout: 30000 })
    rmSync(root, { recursive: true, force: true })
    return r
}

describe('unknown options', () => {
    it('are refused by the parser, positionals included', () => {
        for (const bad of ['--versoin', '--promte', '--no-lve', '--stagin', '-x', 'production', '--prod=1']) {
            expect(() => parseArgs([bad]), bad).toThrow(/unknown option/)
        }
        try { parseArgs(['--bogus']) } catch (e) { expect(e.code).toBe('usage') }
    })

    it('exit 1 with a usage code and never reach the server', () => {
        const r = run(['--json', '--promte'])
        expect(r.status).toBe(1)
        const lines = r.stdout.trim().split('\n')
        expect(lines).toHaveLength(1)
        expect(JSON.parse(lines[0])).toMatchObject({ ok: false, error: 'usage', message: expect.stringMatching(/unknown option "--promte"/) })
    }, 40000)

    it('a typo next to a real flag still refuses', () => {
        const r = run(['--staging', '--no-lve'])
        expect(r.status).toBe(1)
        expect(r.stderr).toMatch(/unknown option "--no-lve", so nothing was published/)
    }, 40000)
})

describe('--version and --help', () => {
    it('print and exit 0 without publishing', () => {
        const v = run(['--version'])
        expect(v.status).toBe(0)
        expect(v.stdout.trim()).toBe(PKG.version)
        expect(packageVersion()).toBe(PKG.version)
        const short = run(['-v'])
        expect(short.stdout.trim()).toBe(PKG.version)
        const json = run(['--version', '--json'])
        expect(JSON.parse(json.stdout.trim())).toEqual({ ok: true, version: PKG.version })
        const h = run(['--help'])
        expect(h.status).toBe(0)
        expect(h.stdout).toMatch(/--list/)
        expect(h.stdout).toMatch(/Unknown options are refused/)
    }, 60000)

    it('win over combination checks', () => {
        expect(parseArgs(['--version', '--production', '--no-live'])).toMatchObject({ version: true })
        expect(parseArgs(['--help', '--deployment', 'd'])).toMatchObject({ help: true })
    })
})

describe('--list', () => {
    it('defaults to production, takes --staging, and refuses publish/promote flags', () => {
        expect(parseArgs(['--list'])).toMatchObject({ list: true, env: 'production' })
        expect(parseArgs(['--list', '--staging', '--json'])).toMatchObject({ list: true, env: 'staging', json: true })
        for (const extra of [['--promote'], ['--no-live'], ['--label', 'x'], ['--deployment', 'd'], ['--expect-live', 'd'], ['--no-render'], ['--source', 'spa']]) {
            expect(() => parseArgs(['--list', ...extra]), extra[0]).toThrow(/does not apply to --list/)
        }
    })

    it('shapes the manifest_deployments answer', () => {
        const { json, lines } = listSummary({
            env: 'staging',
            live_deployment_id: 'dep_a',
            deployments: [
                { deployment_id: 'dep_b', status: 'ready', is_live: false, held: true, label: 'rc1', preview_url: 'https://preview--b.manifestx.ai', published_at: '2026-11-25 10:00:00', source: 'render', files: 3 },
                { deployment_id: 'dep_a', status: 'ready', is_live: true, label: null, published_at: '2026-11-24 10:00:00', source: 'spa' },
            ],
        })
        expect(json).toEqual({
            ok: true,
            env: 'staging',
            live_deployment_id: 'dep_a',
            deployments: [
                { deployment_id: 'dep_b', status: 'ready', is_live: false, held: true, label: 'rc1', preview_url: 'https://preview--b.manifestx.ai', published_at: '2026-11-25 10:00:00', source: 'render' },
                { deployment_id: 'dep_a', status: 'ready', is_live: true, held: false, label: null, preview_url: null, published_at: '2026-11-24 10:00:00', source: 'spa' },
            ],
        })
        expect(lines[0]).toBe('staging: live dep_a')
        expect(lines[1]).toMatch(/dep_b .*\[held, ready\]\s+rc1/)
        expect(listSummary({ env: 'production', deployments: [] }).lines).toEqual(['production: nothing live'])
    })
})

describe('refusal codes', () => {
    it("Node's own error codes are reported as failed", () => {
        const e = new Error('no such file')
        e.code = 'ENOENT'
        expect(jsonFailure(e).error).toBe('failed')
        const n = new Error('x')
        n.code = 'ERR_MODULE_NOT_FOUND'
        expect(jsonFailure(n).error).toBe('failed')
        expect(jsonFailure(codedError('live_moved', 'm')).error).toBe('live_moved')
    })

    it('a server refusal keeps its code through runPromote', async () => {
        const callToolImpl = async () => { throw codedError('live_moved', 'Production is serving dep_x, not dep_y.') }
        await expect(runPromote({ deployment: 'd', expectLive: 'dep_y' }, { url: 'u', key: 'k', callToolImpl, toolParamsImpl: async () => ['deployment_id', 'expect_live'] }))
            .rejects.toMatchObject({ code: 'live_moved', message: expect.stringMatching(/dep_x/) })
    })

    it('an older server is refused as unsupported_server, and a mismatched promote as promoted_other', async () => {
        await expect(runPromote({ deployment: 'd' }, { url: 'u', key: 'k', callToolImpl: async () => ({}), toolParamsImpl: async () => [] }))
            .rejects.toMatchObject({ code: 'unsupported_server' })
        await expect(runPromote({ deployment: 'd' }, { url: 'u', key: 'k', callToolImpl: async () => ({ from_deployment_id: 'other' }), toolParamsImpl: async () => ['deployment_id'] }))
            .rejects.toMatchObject({ code: 'promoted_other' })
    })
})
