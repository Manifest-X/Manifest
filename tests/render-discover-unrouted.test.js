import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRoutes } from '../src/scripts/manifest.render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const yaml = (group, ...paths) =>
  `- group: "${group}"\n  slug: "${group.toLowerCase().replace(/\s+/g, '-')}"\n  items:\n` +
  paths.map((p) => `    - name: "${p}"\n      path: "${p}"\n`).join('');

let dir;

function site(indexBody, data, files) {
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), `<html><body>${indexBody}</body></html>`);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'data', name), text);
  return discoverRoutes({ data }, dir);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mnfst-discover-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('data path discovery: only routes some x-route shows', () => {
  it('mounts a source under a plain route named after it (docs template)', () => {
    const routes = site('<x-docs x-route="docs"></x-docs>', { docs: '/data/docs.yaml' }, {
      'docs.yaml': yaml('Getting Started', 'introduction', 'installation') + yaml('Guides', 'writing-articles'),
    });
    expect(routes).toEqual(expect.arrayContaining([
      'docs',
      'docs/getting-started/introduction',
      'docs/getting-started/installation',
      'docs/guides/writing-articles',
    ]));
    expect(routes.filter((r) => !r.startsWith('docs') && r !== '')).toEqual([]);
  });

  it('mounts under a /-prefixed route too, but not under an exact one', () => {
    const prefixed = site('<div x-route="/docs"></div>', { docs: '/data/docs.yaml' }, { 'docs.yaml': yaml('Guides', 'a') });
    expect(prefixed).toContain('docs/guides/a');
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'mnfst-discover-'));
    const exact = site('<div x-route="=docs"></div>', { docs: '/data/docs.yaml' }, { 'docs.yaml': yaml('Guides', 'a') });
    expect(exact).toEqual(['', 'docs']);
  });

  it('drops data paths no route condition matches', () => {
    const routes = site('<div x-route="/"></div><div x-route="about"></div>', { faq: '/data/faq.yaml' }, {
      'faq.yaml': '- question: "Why"\n  slug: "why"\n- question: "How"\n  slug: "about-how"\n',
    });
    expect(routes).toContain('about-how');
    expect(routes).not.toContain('why');
  });

  it('keeps data paths when a catch-all route shows every path', () => {
    const routes = site('<div x-route="*"></div>', { faq: '/data/faq.yaml' }, { 'faq.yaml': '- slug: "why"\n' });
    expect(routes).toContain('why');
  });

  it('keeps every data path when the site has no route conditions at all', () => {
    const routes = site('<main></main>', { posts: '/data/posts.yaml' }, { 'posts.yaml': '- slug: "hello"\n' });
    expect(routes).toEqual(['', 'hello']);
  });

  it('the shipped docs template discovers its article routes and no bogus ones', () => {
    const tpl = join(here, '../packages/docs/template');
    cpSync(tpl, dir, { recursive: true });
    cpSync(join(here, '../packages/docs/components'), join(dir, 'components'), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const routes = discoverRoutes(manifest, dir);
    expect(routes).toContain('docs/getting-started/introduction');
    expect(routes.filter((r) => r && !r.startsWith('docs'))).toEqual([]);
  });

  it('follows unlisted <x-name> tags to components/<name>.html, recursively', () => {
    mkdirSync(join(dir, 'components'), { recursive: true });
    writeFileSync(join(dir, 'components', 'shell.html'), '<x-blog></x-blog>');
    writeFileSync(join(dir, 'components', 'blog.html'), '<section x-route="blog/*"></section>');
    const routes = site('<x-shell></x-shell>', { blog: '/data/blog.yaml' }, { 'blog.yaml': yaml('Posts', 'hello') });
    expect(routes).toContain('blog/posts/hello');
    expect(routes).not.toContain('posts/hello');
  });

  it('keeps every data path when an x-route is bound', () => {
    const routes = site('<div x-route="about"></div><div :x-route="page.route"></div>', { pages: '/data/pages.yaml' }, {
      'pages.yaml': '- slug: "pricing"\n',
    });
    expect(routes).toContain('pricing');
  });

  it('a bound x-route keeps the plain-route mount too', () => {
    const routes = site('<x-docs x-route="docs"></x-docs><div :x-route="page.route"></div>', { docs: '/data/docs.yaml' }, {
      'docs.yaml': yaml('Guides', 'intro'),
    });
    expect(routes).toContain('docs/guides/intro');
  });
});


describe('data path discovery: group slugs', () => {
  it('prefixes grouped paths with the group slug when one is set', () => {
    const routes = site('<x-docs x-route="docs"></x-docs>', { docs: '/data/docs.yaml' }, {
      'docs.yaml': '- group: "Getting started"\n  slug: "start"\n  items:\n    - name: "Welcome"\n      path: "welcome"\n'
        + '- group: "Billing"\n  items:\n    - name: "Invoices"\n      path: "invoices"\n',
    });
    expect(routes).toEqual(expect.arrayContaining(['docs/start', 'docs/start/welcome', 'docs/billing/invoices']));
    expect(routes.filter((r) => r.includes('getting-started'))).toEqual([]);
  });
});
