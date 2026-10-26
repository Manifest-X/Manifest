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

describe('data path discovery: group slugs, all sources', () => {
  const docs = (data, files) => {
    const warnings = [];
    const err = process.stderr.write;
    process.stderr.write = (m) => { warnings.push(String(m)); return true; };
    try {
      return { routes: site('<x-docs x-route="docs"></x-docs>', data, files), warnings };
    } finally {
      process.stderr.write = err;
    }
  };

  it('JSON groups use their slug', () => {
    const { routes } = docs({ docs: '/data/docs.json' }, {
      'docs.json': JSON.stringify([{ group: 'Getting Started', slug: 'start', items: [{ path: 'welcome' }] }, { group: 'Two', slug: 2, items: [{ path: 'x' }] }]),
    });
    expect(routes).toEqual(expect.arrayContaining(['docs/start/welcome', 'docs/2/x']));
    expect(routes.filter((r) => r.includes('getting-started') || r.includes('two'))).toEqual([]);
  });

  it('a YAML group slug written after its items still applies', () => {
    const { routes } = docs({ docs: '/data/docs.yaml' }, {
      'docs.yaml': '- group: "Getting started"\n  items:\n    - name: "Welcome"\n      path: "welcome"\n  slug: "start"\n- group: "Billing"\n  items:\n    - path: "invoices"\n',
    });
    expect(routes).toEqual(expect.arrayContaining(['docs/start/welcome', 'docs/billing/invoices']));
    expect(routes.filter((r) => r.includes('getting-started'))).toEqual([]);
  });

  it('YAML slugs resolve as the runtime loads them', () => {
    const group = (name, slug) => `- group: "${name}"\n  slug: ${slug}\n  items:\n    - path: "a"\n`;
    const { routes, warnings } = docs({ docs: '/data/docs.yaml' }, {
      'docs.yaml': group('One', '01') + group('Quoted', '"01"') + group('Exp', '1e3') + group('Gone', 'null') + group('Note', 'notes # a comment'),
    });
    expect(routes).toEqual(expect.arrayContaining(['docs/1/a', 'docs/01/a', 'docs/1000/a', 'docs/gone/a', 'docs/notes/a']));
    expect(routes.filter((r) => /docs\/(one|quoted|exp|note)\b/.test(r))).toEqual([]);
    expect(warnings.join('')).toContain('"Gone" has an empty slug');
  });

  it('plain scalars resolve like js-yaml', async () => {
    const { yamlScalar } = await import('../src/scripts/manifest.render.page.mjs');
    const yaml = (await import('js-yaml')).default;
    for (const v of ['01', '1e3', 'null', '~', '', 'true', 'False', '0x1F', '0o17', '017', '1_000', '1.50', '.5', '-0', '+3', '0b101', 'start', '"01"', "'01'", 'start # c', 'a#b', '"a\\"b"', "'it''s'", '1:2', 'a b', '.inf', '0x_1', '1e400']) {
      const want = yaml.load(`v: ${v}`).v;
      expect(yamlScalar(v), v).toBe(want === null ? null : String(want));
    }
  });
});
