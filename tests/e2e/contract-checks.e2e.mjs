/**
 * Contract column checks on an Appwrite source, in real Chromium against the
 * mnfst-test fake Appwrite (tests/fixtures/contract-appwrite).
 *
 *   a) declared columns render; present-but-undeclared columns only warn
 *   b) a misspelt column read throws, naming the column, table and source
 *   c) realtime rows with undeclared columns, $update and $create stay quiet
 *   d) checks: false turns it off
 *
 * Run: npm run build && node tests/e2e/contract-checks.e2e.mjs
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { launch } from '../../packages/test/browser.mjs'
import { heavyTenant } from '../../packages/test/fixtures.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = path.join(ROOT, 'tests', 'fixtures', 'contract-appwrite')
const statuses = ['open', 'done']
const fake = heavyTenant({
    main: {
        tasks: (i) => ({ title: `Task ${String(i + 1).padStart(2, '0')}`, status: statuses[i % 2], priority: i }),
        projects: { count: 1, build: () => ({ name: 'Launch', fileIds: ['f1'] }) }
    }
}, { rows: 5, buckets: { assets: [{ $id: 'f1', name: 'a.png' }, { $id: 'f2', name: 'b.png' }] } })

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
    const kit = await launch({ root: APP, mounts: { '/lib/': path.join(ROOT, 'lib') }, fake })
    try {
        const j = await kit.open('/')
        const warnings = []
        j.page.on('console', (m) => { if (m.type() === 'warn' || m.type() === 'warning') warnings.push(m.text()) })
        await j.waitForData('tasks')
        await wait(300)
        const rows = await j.page.$$eval('#tasks li', (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' ')))
        check('declared columns render', rows.length === 5 && rows[0] === 'Task 01 open', JSON.stringify(rows.slice(0, 2)))
        check('no errors while every read is declared or present', j.errors.length === 0, j.errors.slice(0, 2).join(' | '))
        warnings.length = 0
        await j.page.reload({ waitUntil: 'load' })
        await j.waitForData('tasks')
        await wait(300)
        check('present-but-undeclared column warns once', warnings.filter((w) => w.includes('"priority"')).length === 1, warnings.join(' | ').slice(0, 300))

        j.errors.length = 0
        await j.page.click('#typo')
        await wait(300)
        const typoErr = j.errors.find((e) => e.includes('"stauts" is not a column of "tasks" in the contract (data source "tasks")'))
        check('misspelt column read throws, naming column, table and source', !!typoErr, j.errors.slice(0, 2).join(' | '))

        await j.page.reload({ waitUntil: 'load' })
        await j.waitForData('tasks')
        j.errors.length = 0
        await j.fake.table('main', 'tasks').insert({ title: 'Task 00 live', status: 'open', priority: 9, owner: 'x' })
        await j.page.waitForFunction(() => [...document.querySelectorAll('#tasks li')].some((li) => li.textContent.includes('Task 00 live')), { timeout: 10000 }).catch(() => {})
        const id = await j.x('$x.tasks[1].$id')
        await j.x(`$x.tasks.$update('${id}', { status: 'done' })`)
        await j.x(`$x.tasks.$create({ title: 'Task 99 made here', status: 'open' })`)
        const found = await j.x(`$x.tasks.$search('live', 'title').length`)
        const tasks = (fn) => j.page.evaluate(fn)
        const first = await tasks(async () => (await window.Alpine.evaluate(document.body, '$x.tasks').$first(2)).items.length)
        const page = await tasks(async () => (await window.Alpine.evaluate(document.body, '$x.tasks').$page(1, 2)).items.map((t) => t.title + ':' + t.status).join(','))
        const delId = await j.x('$x.tasks[2].$id')
        await j.x(`$x.tasks.$delete('${delId}')`)
        await wait(800)
        check('$search, $first, $page and $delete work under checks', found === 1 && first > 0 && /^Task/.test(page) && !(await j.fake.table('main', 'tasks').rows()).some((r) => r.$id === delId), `${found} ${first} ${page}`)
        const after = await j.page.$$eval('#tasks li', (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' ')))
        check('realtime row with undeclared columns lands quietly', after.some((r) => r.startsWith('Task 00 live')))
        const before = j.errors.length
        await j.page.evaluate(() => { try { window.Alpine.evaluate(document.body, "$x.tasks.find(t => t.title === 'Task 00 live').nope") } catch (e) { console.error(e.message) } })
        await wait(100)
        check('a sorted realtime insert is checked like any row', j.errors.slice(before).some((e) => e.includes('"nope" is not a column')), j.errors.slice(before).join(' | '))
        j.errors.length = before
        check('$update and $create work under checks', after.includes('Task 99 made here open') && (await j.fake.table('main', 'tasks').get(id)).status === 'done')
        await j.x(`$x.tasks.$update('${id}', { owner: 'z' })`)
        const liveId = await j.x('$x.tasks[0].$id')
        await j.fake.table('main', 'tasks').update(liveId, { reviewer: 'y' })
        await wait(600)
        check('$update and realtime updates that add undeclared columns land', (await j.fake.table('main', 'tasks').get(id)).owner === 'z' && await j.x(`$x.tasks.find(t => t.$id === '${liveId}').reviewer`) === 'y')

        await j.waitForData('projects')
        await j.page.waitForFunction(() => document.querySelector('#projects .files')?.textContent === '1', { timeout: 5000 }).catch(() => {})
        const filesBefore = await j.page.$eval('#projects .files', (el) => el.textContent)
        const projectId = await j.x('$x.projects[0].$id')
        await j.fake.table('main', 'projects').update(projectId, { fileIds: ['f1', 'f2'] })
        await j.page.waitForFunction(() => document.querySelector('#projects .files')?.textContent === '2', { timeout: 5000 }).catch(() => {})
        const filesAfter = await j.page.$eval('#projects .files', (el) => el.textContent)
        check('$files follows fileIds on a storage-backed source', filesBefore === '1' && filesAfter === '2', `${filesBefore} → ${filesAfter}`)
        check('no errors from framework reads', j.errors.length === 0, j.errors.slice(0, 2).join(' | '))
        await j.close()

        const off = await kit.open('/', { routes: [{ url: kit.origin + '/manifest.json', contentType: 'application/json', body: JSON.stringify({ ...JSON.parse((await import('fs')).readFileSync(path.join(APP, 'manifest.json'), 'utf8')), contract: { module: '/shared/contract.js', checks: false } }) }] })
        await off.waitForData('tasks')
        await off.page.click('#typo')
        await wait(300)
        check('checks: false turns column checks off', off.errors.length === 0, off.errors.slice(0, 2).join(' | '))
        await off.close()
    } catch (e) {
        check('run', false, e.stack)
    } finally {
        await kit.close()
    }
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
    process.exit(failed ? 1 : 0)
}

main()
