import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverRoutes } from '../src/scripts/manifest.render.mjs';

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

describe('data path discovery: wildcard mounts', () => {
  it('mounts a source under a nested wildcard base ending in its key', () => {
    const routes = site(
      '<div x-route="docs/framework/*"></div><div x-route="docs/platform/*"></div>',
      { framework: '/data/framework.yaml', platform: '/data/platform.yaml' },
      {
        'framework.yaml': yaml('Getting Started', 'introduction', 'setup'),
        'platform.yaml': yaml('Claude', 'connector'),
      },
    );
    expect(routes).toEqual(expect.arrayContaining([
      'docs/framework/getting-started/introduction',
      'docs/framework/getting-started/setup',
      'docs/platform/claude/connector',
    ]));
    expect(routes.some((r) => r.startsWith('getting-started') || r.startsWith('claude'))).toBe(false);
  });

  it('still mounts a source under a single-segment base named after it', () => {
    const routes = site(
      '<div x-route="/docs/*"></div>',
      { docs: '/data/docs.yaml' },
      { 'docs.yaml': yaml('Core Plugins', 'router') },
    );
    expect(routes).toContain('docs/core-plugins/router');
  });

  it('prefers a base named exactly after the key over a nested one', () => {
    const routes = site(
      '<div x-route="blog/*"></div><div x-route="archive/blog/*"></div>',
      { blog: '/data/blog.yaml' },
      { 'blog.yaml': yaml('Posts', 'hello') },
    );
    expect(routes).toContain('blog/posts/hello');
    expect(routes.some((r) => r.startsWith('archive/'))).toBe(false);
  });

  it('mounts nowhere when several nested bases end in the key', () => {
    const routes = site(
      '<div x-route="a/docs/*"></div><div x-route="b/docs/*"></div>',
      { docs: '/data/docs.yaml' },
      { 'docs.yaml': yaml('Styles', 'theme') },
    );
    expect(routes.some((r) => r.endsWith('styles/theme'))).toBe(false);
  });

  it('keeps a locale prefix in front of a nested mount', () => {
    const json = JSON.stringify([{ path: 'fr/intro' }, { path: 'fr/docs/framework/setup' }]);
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'framework.json'), json);
    writeFileSync(join(dir, 'data', 'strings.fr.yaml'), 'hello: "bonjour"\n');
    const routes = site(
      '<div x-route="docs/framework/*"></div>',
      { framework: '/data/framework.json', strings: { fr: '/data/strings.fr.yaml' } },
      {},
    );
    expect(routes).toEqual(expect.arrayContaining(['fr/docs/framework/intro', 'fr/docs/framework/setup']));
    expect(routes).not.toContain('fr/docs/framework/docs/framework/setup');
  });
});
