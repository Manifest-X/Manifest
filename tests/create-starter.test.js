/**
 * mnfst-starter CLI: no env-var key fallback, --here refuses to overwrite
 * without --force, .mcp.json/.claude/settings.json/.env are merged, and the
 * ui-guard hook is registered only when its script exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/create-starter/create-starter.js')
const KEY = 'mfst_free_' + 'a'.repeat(24)
const GUARD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ui-guard.mjs"'

let dir
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, MANIFEST_API_KEY: '', ...env },
})
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8')
const json = (f) => JSON.parse(read(f))
const write = (f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c) }
const exists = (f) => fs.existsSync(path.join(dir, f))

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-starter-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('mnfst-starter', () => {
    it('plain run ignores MANIFEST_API_KEY and writes no MCP wiring', () => {
        const r = run(['--here', '--name', 'Site'], { MANIFEST_API_KEY: KEY })
        expect(r.status).toBe(0)
        expect(exists('index.html')).toBe(true)
        expect(exists('.env')).toBe(false)
        expect(exists('.mcp.json')).toBe(false)
        expect(exists('.claude/settings.json')).toBe(false)
    })

    it('fresh folder with project id + key wires production MCP, no hook, key not printed', () => {
        const r = run(['--here', '--name', 'Site', '--project-id=proj_1', `--key=${KEY}`])
        expect(r.status).toBe(0)
        expect(r.stdout + r.stderr).not.toContain(KEY)
        expect(json('.mcp.json').mcpServers.manifest).toEqual({
            type: 'http', url: 'https://mcp.manifestx.dev/mcp', headers: { 'X-Manifest-Project': 'proj_1' },
        })
        const s = json('.claude/settings.json')
        expect(s.permissions.allow).toEqual(['mcp__manifest'])
        expect(s.hooks).toBeUndefined()
        expect(read('.env')).toContain(`MANIFEST_API_KEY=${KEY}`)
        expect(read('.gitignore')).toMatch(/^\.env$/m)
        expect(read('.gitignore').match(/^\*\.tgz$/gm)).toHaveLength(1)
    })

    it('honours --mcp-url', () => {
        expect(run(['--here', '--name', 'Site', '--project-id=p', '--mcp-url=https://staging.example/mcp']).status).toBe(0)
        expect(json('.mcp.json').mcpServers.manifest.url).toBe('https://staging.example/mcp')
    })

    it('refuses to overwrite existing files in --here mode and lists them', () => {
        write('index.html', 'mine')
        write('components/header.html', 'mine')
        write('components/own.html', 'mine')
        const r = run(['--here', '--name', 'Site'])
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('index.html')
        expect(r.stderr).toContain('components/header.html')
        expect(r.stderr).not.toContain('own.html')
        expect(r.stderr).toContain('--force')
        expect(read('index.html')).toBe('mine')
        expect(exists('manifest.json')).toBe(false)
    })

    it('scaffolds into a non-empty folder without collisions, keeping unrelated files', () => {
        write('notes.txt', 'keep')
        write('components/own.html', 'keep')
        expect(run(['--here', '--name', 'Site']).status).toBe(0)
        expect(read('notes.txt')).toBe('keep')
        expect(read('components/own.html')).toBe('keep')
        expect(exists('components/header.html')).toBe(true)
    })

    it('--force overwrites', () => {
        write('index.html', 'mine')
        expect(run(['--here', '--name', 'Site', '--force']).status).toBe(0)
        expect(read('index.html')).not.toBe('mine')
    })

    it('merges existing .mcp.json, settings.json and .env', () => {
        write('.mcp.json', JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'x' } } }))
        write('.claude/settings.json', JSON.stringify({
            permissions: { allow: ['Bash(ls)'] },
            hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] },
            model: 'opus',
        }))
        write('.env', 'OTHER=1\nMANIFEST_API_KEY=old\n')
        expect(run(['--here', '--name', 'Site', '--project-id=p', `--key=${KEY}`]).status).toBe(0)
        const m = json('.mcp.json')
        expect(m.mcpServers.other).toEqual({ type: 'stdio', command: 'x' })
        expect(m.mcpServers.manifest.headers).toEqual({ 'X-Manifest-Project': 'p' })
        const s = json('.claude/settings.json')
        expect(s.permissions.allow).toEqual(['Bash(ls)', 'mcp__manifest'])
        expect(s.model).toBe('opus')
        expect(s.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }])
        expect(read('.env')).toBe(`OTHER=1\nMANIFEST_API_KEY=${KEY}\n`)
    })

    it('registers ui-guard once when its script is present', () => {
        write('.claude/hooks/ui-guard.mjs', '')
        expect(run(['--here', '--name', 'Site', '--project-id=p']).status).toBe(0)
        const s = json('.claude/settings.json')
        expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: GUARD }] }])
        expect(s.hooks.PreToolUse).toEqual([{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: GUARD }] }])
    })

    it('aborts before writing anything when settings.json is malformed', () => {
        write('.claude/settings.json', '{ nope')
        const r = run(['--here', '--name', 'Site', '--project-id=p'])
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('settings.json')
        expect(exists('index.html')).toBe(false)
        expect(read('.claude/settings.json')).toBe('{ nope')
    })

    it('subfolder mode still refuses an existing directory', () => {
        fs.mkdirSync(path.join(dir, 'Site'))
        expect(run(['Site']).status).toBe(1)
    })
})
