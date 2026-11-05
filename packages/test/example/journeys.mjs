// Golden journeys for the example app: `npx mnfst-test journeys example/journeys.mjs`
import { heavyTenant, emptyTenant } from '../fixtures.mjs';

const schema = { main: { tasks: (i, { words }) => ({ title: `${words(2)} ${i + 1}`, done: i % 3 === 0 }) } };
const heavy = heavyTenant(schema, { rows: 3000 });
const empty = emptyTenant(schema);
const expect = (cond, message) => { if (!cond) throw new Error(message); };

export default {
    root: '.',
    mounts: { '/lib/': process.env.MNFST_LIB || '../../../lib' },
    snapshots: '__screenshots__',
    viewport: { width: 800, height: 900 },
    journeys: [
        {
            name: 'empty tenant',
            fake: empty,
            async steps(j) {
                await j.waitForData('tasks');
                expect(await j.page.$eval('[data-testid=empty]', el => el.offsetParent !== null), 'empty state hidden');
                await j.snap('empty');
                await j.page.type('input[name=title]', 'First task');
                await j.page.click('button[type=submit]');
                await j.page.waitForFunction(() => document.querySelectorAll('[data-testid=list] li').length === 1);
                expect((await j.fake.table('tasks').rows()).length === 1, 'row not stored');
                await j.snap('first task');
            }
        },
        {
            name: 'heavy tenant',
            fake: heavy,
            async steps(j) {
                await j.waitForData('tasks');
                expect(await j.x('$x.tasks.length') === 100, 'default query should load 100 rows');
                await j.snap('list');
                await j.page.type('input[name=term]', 'cobalt');
                await j.settle();
                await j.snap('search');
                await j.page.click('[data-testid=page]');
                await j.page.click('[data-testid=page]');
                await j.page.waitForFunction(() => document.querySelector('[data-testid=pager]').textContent.startsWith('Page 2'));
                await j.snap('page 2', { selector: '[data-testid=pager]' });
            }
        },
        {
            name: 'realtime from another user',
            fake: heavy,
            async steps(j) {
                await j.waitForData('tasks');
                await j.fake.table('tasks').insert({ title: 'Arrived live', done: false });
                await j.page.waitForFunction(() => window.Alpine.evaluate(document.body, '$x.tasks.some(t => t.title === "Arrived live")'));
                await j.fake.table('tasks').update('tas003000', { title: 'Renamed live' });
                await j.fake.table('tasks').remove('tas002999');
                // Newest first: the live row sorts above the renamed one
                await j.page.waitForFunction(() => [...document.querySelectorAll('[data-testid=list] li span')].slice(0, 2).map(el => el.textContent).join('|') === 'Arrived live|Renamed live');
                expect(await j.x('$x.tasks.length') === 100, 'create then delete should net 100 rows');
                await j.page.type('input[name=term]', 'live');
                await j.settle();
                await j.snap('live');
            }
        }
    ]
};
