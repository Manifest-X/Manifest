/**
 * mnfst-publish: held publishes (--no-live), labels, promote by id
 * (--promote --deployment) and the expect-live guard. An older server drops
 * arguments it does not know, so every new flag is confirmed with the server
 * before anything is uploaded or promoted.
 */
import { describe, it, expect } from 'vitest'
import {
    parseArgs,
    promoteToolArgs,
    publishToolArgs,
    unsupportedPromoteArgs,
    runPromote,
    checkHeldHandshake,
    checkHeldLink,
    publishSummary,
} from '../packages/publish/manifest.publish.mjs'

describe('parseArgs', () => {
    it('--no-live implies staging and keeps the label', () => {
        expect(parseArgs(['--no-live', '--label', '  v2.4.0 rc1  '])).toMatchObject({ env: 'staging', live: false, label: 'v2.4.0 rc1' })
        expect(parseArgs(['--staging', '--no-live'])).toMatchObject({ env: 'staging', live: false })
    })

    it('refuses --no-live on production', () => {
        expect(() => parseArgs(['--production', '--no-live'])).toThrow(/only applies to staging/)
        expect(() => parseArgs(['--env', 'production', '--no-live'])).toThrow(/only applies to staging/)
    })

    it('bounds and screens the label', () => {
        expect(parseArgs(['--label', 'x'.repeat(200)]).label).toHaveLength(200)
        expect(() => parseArgs(['--label', 'x'.repeat(201)])).toThrow(/at most 200/)
        expect(() => parseArgs(['--label', 'a\nb'])).toThrow(/printable/)
        expect(() => parseArgs(['--label', '   '])).toThrow(/empty/)
        expect(() => parseArgs(['--label'])).toThrow(/needs a value/)
        expect(() => parseArgs(['--label', '--staging'])).toThrow(/needs a value/)
    })

    it('takes --deployment and --expect-live only with --promote', () => {
        expect(parseArgs(['--promote', '--deployment', 'dep_a', '--expect-live', 'dep_b'])).toMatchObject({ promote: true, deployment: 'dep_a', expectLive: 'dep_b' })
        expect(() => parseArgs(['--deployment', 'dep_a'])).toThrow(/only applies with --promote/)
        expect(() => parseArgs(['--expect-live', 'dep_a'])).toThrow(/only applies with --promote/)
        expect(() => parseArgs(['--promote', '--no-live'])).toThrow(/not to --promote/)
        expect(() => parseArgs(['--promote', '--label', 'x'])).toThrow(/--label is set when publishing/)
    })

    it('leaves the old flags alone', () => {
        expect(parseArgs([])).toMatchObject({ env: 'production', promote: false })
        expect(parseArgs([]).live).toBeUndefined()
        expect(parseArgs(['--promote'])).toMatchObject({ promote: true })
        expect(promoteToolArgs(parseArgs(['--promote']))).toEqual({})
    })
})

describe('tool arguments', () => {
    it('publish handshake carries live=false and the label only when set', () => {
        expect(publishToolArgs(parseArgs(['--staging']), 'spa')).toEqual({ env: 'staging', source: 'spa', via_cli: true })
        expect(publishToolArgs(parseArgs(['--no-live', '--label', 'L']), 'render')).toEqual({ env: 'staging', source: 'render', via_cli: true, live: false, label: 'L' })
    })

    it('promote carries deployment_id and expect_live', () => {
        expect(promoteToolArgs(parseArgs(['--promote', '--deployment', 'dep_a', '--expect-live', 'dep_p']))).toEqual({ deployment_id: 'dep_a', expect_live: 'dep_p' })
    })

    it('names arguments an older server would drop', () => {
        expect(unsupportedPromoteArgs({ deployment_id: 'x' }, ['project_id'])).toEqual(['deployment_id'])
        expect(unsupportedPromoteArgs({ deployment_id: 'x', expect_live: 'y' }, ['project_id', 'deployment_id', 'expect_live'])).toEqual([])
        expect(unsupportedPromoteArgs({ deployment_id: 'x' }, null)).toEqual(['deployment_id'])
    })
})

describe('runPromote', () => {
    const ctx = (params, result) => {
        const calls = []
        return {
            calls,
            url: 'https://mcp.example.dev/mcp',
            key: 'k',
            toolParamsImpl: async () => params,
            callToolImpl: async (_url, _key, name, args) => {
                calls.push({ name, args })
                if (result instanceof Error) throw result
                return result
            },
        }
    }

    it('promotes by id on a server that knows the arguments', async () => {
        const c = ctx(['project_id', 'deployment_id', 'expect_live'], { live_deployment_id: 'dep_p2', from_deployment_id: 'dep_a', label: 'A', url: 'https://x' })
        const res = await runPromote(parseArgs(['--promote', '--deployment', 'dep_a', '--expect-live', 'dep_p1']), c)
        expect(res.from_deployment_id).toBe('dep_a')
        expect(c.calls).toEqual([{ name: 'manifest_promote', args: { deployment_id: 'dep_a', expect_live: 'dep_p1' } }])
    })

    it('refuses before promoting when the server would drop the id', async () => {
        const c = ctx(['project_id'], { live_deployment_id: 'dep_p2' })
        await expect(runPromote(parseArgs(['--promote', '--deployment', 'dep_a']), c)).rejects.toThrow(/does not support --deployment yet, so nothing was promoted/)
        await expect(runPromote(parseArgs(['--promote', '--expect-live', 'dep_p']), c)).rejects.toThrow(/does not support --expect-live/)
        expect(c.calls).toEqual([])
    })

    it('the plain promote skips the capability check', async () => {
        const c = ctx(null, { live_deployment_id: 'dep_p2', url: 'https://x' })
        await runPromote(parseArgs(['--promote']), c)
        expect(c.calls).toEqual([{ name: 'manifest_promote', args: {} }])
    })

    it('passes server refusals through', async () => {
        const c = ctx(['deployment_id', 'expect_live'], new Error('Production is serving dep_x, not dep_p, so nothing was promoted.'))
        await expect(runPromote(parseArgs(['--promote', '--deployment', 'dep_a', '--expect-live', 'dep_p']), c)).rejects.toThrow(/serving dep_x/)
    })

    it('flags a server that promoted something else', async () => {
        const c = ctx(['deployment_id'], { live_deployment_id: 'dep_p2', from_deployment_id: 'dep_other' })
        await expect(runPromote(parseArgs(['--promote', '--deployment', 'dep_a']), c)).rejects.toThrow(/promoted dep_other, not dep_a/)
    })
})

describe('held publish confirmation', () => {
    it('the handshake must echo live=false', () => {
        const opts = parseArgs(['--no-live'])
        expect(() => checkHeldHandshake(opts, { upload_url: 'u', live: false })).not.toThrow()
        expect(() => checkHeldHandshake(opts, { upload_url: 'u' })).toThrow(/does not support --no-live yet, so nothing was uploaded/)
        expect(() => checkHeldHandshake(parseArgs([]), { upload_url: 'u' })).not.toThrow()
    })

    it('a connector link must report live=false on its status before upload', async () => {
        const seen = []
        const fetchImpl = (body) => async (url) => {
            seen.push(url)
            return { status: 200, text: async () => JSON.stringify(body) }
        }
        await expect(checkHeldLink('https://mcp.example.dev/publish/put_a', { fetchImpl: fetchImpl({ status: 'pending', live: false }) })).resolves.toBeUndefined()
        expect(seen).toEqual(['https://mcp.example.dev/publish/put_a/status'])
        await expect(checkHeldLink('https://mcp.example.dev/publish/put_a', { fetchImpl: fetchImpl({ status: 'pending' }) })).rejects.toThrow(/not minted as a held publish/)
        await expect(
            checkHeldLink('https://mcp.example.dev/publish/put_a', {
                fetchImpl: async () => {
                    throw new Error('offline')
                },
            }),
        ).rejects.toThrow(/not minted as a held publish/)
    })
})

describe('publishSummary', () => {
    it('a held publish prints the preview and the promote command', () => {
        const { lines, json } = publishSummary(parseArgs(['--no-live', '--label', 'L']), {
            ok: true,
            env: 'staging',
            deployment_id: 'dep_abc',
            live: false,
            url: 'https://preview--abc.manifestx.ai',
            preview_url: 'https://preview--abc.manifestx.ai',
            label: 'L',
        })
        expect(json).toEqual({ ok: true, env: 'staging', deployment_id: 'dep_abc', live: false, url: 'https://preview--abc.manifestx.ai', preview_url: 'https://preview--abc.manifestx.ai', label: 'L' })
        expect(lines.join('\n')).toContain('npx mnfst-publish --promote --deployment dep_abc')
        expect(lines.join('\n')).toContain('Preview: https://preview--abc.manifestx.ai')
    })

    it('a live publish keeps the old lines and adds the deployment id', () => {
        const { lines, json } = publishSummary(parseArgs(['--staging']), { ok: true, env: 'staging', deployment_id: 'dep_s', url: 'https://s-staging.manifestx.ai' })
        expect(json).toMatchObject({ live: true, deployment_id: 'dep_s', label: null })
        expect(json.preview_url).toBeUndefined()
        expect(lines).toContain('✓ Published to staging: https://s-staging.manifestx.ai')
        expect(lines).toContain('  Deployment: dep_s')
    })
})
