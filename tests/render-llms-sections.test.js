import { describe, it, expect } from 'vitest';
import { groupLlmsSections } from '../src/scripts/manifest.render.mjs';

const entries = (rows) => rows.map(([pathSeg, title]) => ({ pathSeg, title }));
const shape = (sections) => [...sections].map(([key, s]) => [key, s.label, s.entries.map((e) => e.pathSeg)]);

describe('llms.txt sections', () => {
    it('groups by first segment, root as Overview, in first-encounter order', () => {
        const out = groupLlmsSections(entries([
            ['', 'Home — Site'],
            ['blog/post-a', 'Post A — Site'],
            ['about', 'About — Site'],
            ['blog/post-b', 'Post B — Site'],
        ]), 'Site');
        expect(shape(out)).toEqual([
            ['Overview', 'Overview', ['']],
            ['blog', 'Blog', ['blog/post-a', 'blog/post-b']],
            ['about', 'About', ['about']],
        ]);
    });

    it('splits a segment into one section per doc family, labelled by page title', () => {
        const out = groupLlmsSections(entries([
            ['docs', 'Docs — Manifest'],
            ['docs/ai', 'AI Plugins — Manifest'],
            ['docs/ai/quickstart', 'Quickstart — Manifest'],
            ['docs/ai/setup/claude', 'Claude — Manifest'],
            ['docs/framework', 'Framework — Manifest'],
            ['docs/framework/core-plugins/chat', 'Chat — Manifest'],
        ]), 'Manifest');
        expect(shape(out)).toEqual([
            ['docs', 'Docs', ['docs']],
            ['docs/ai', 'AI Plugins', ['docs/ai', 'docs/ai/quickstart', 'docs/ai/setup/claude']],
            ['docs/framework', 'Framework', ['docs/framework', 'docs/framework/core-plugins/chat']],
        ]);
    });

    it('keeps a single sub-area in its parent section', () => {
        const out = groupLlmsSections(entries([
            ['docs', 'Docs — Site'],
            ['docs/guide', 'Guide — Site'],
            ['docs/guide/install', 'Install — Site'],
            ['docs/faq', 'FAQ — Site'],
        ]), 'Site');
        expect(shape(out)).toEqual([
            ['docs', 'Docs', ['docs', 'docs/guide', 'docs/guide/install', 'docs/faq']],
        ]);
    });

    it('needs the sub-area page itself before treating it as a family', () => {
        const out = groupLlmsSections(entries([
            ['docs/a/one', 'One — Site'],
            ['docs/b/two', 'Two — Site'],
        ]), 'Site');
        expect(shape(out)).toEqual([
            ['docs', 'Docs', ['docs/a/one', 'docs/b/two']],
        ]);
    });

    it('falls back to the slug when a family page has no usable title', () => {
        const out = groupLlmsSections(entries([
            ['docs/user-guide', ''],
            ['docs/user-guide/start', 'Start'],
            ['docs/api', 'API Reference | Acme (Beta)'],
            ['docs/api/auth', 'Auth'],
        ]), 'Acme (Beta)');
        expect(shape(out).map(([key, label]) => [key, label])).toEqual([
            ['docs/user-guide', 'User Guide'],
            ['docs/api', 'API Reference'],
        ]);
    });

    it('splits recursively, so groups inside a family keep their own sections', () => {
        const out = groupLlmsSections(entries([
            ['docs', 'Docs — Manifest'],
            ['docs/ai', 'AI Plugins — Manifest'],
            ['docs/ai/quickstart', 'Quickstart — Manifest'],
            ['docs/framework', 'Framework — Manifest'],
            ['docs/framework/getting-started', 'Getting Started — Manifest'],
            ['docs/framework/getting-started/setup', 'Setup — Manifest'],
            ['docs/framework/core-plugins', 'Core Plugins — Manifest'],
            ['docs/framework/core-plugins/chat', 'Chat — Manifest'],
            ['docs/framework/core-plugins/router', 'Router — Manifest'],
        ]), 'Manifest');
        expect(shape(out)).toEqual([
            ['docs', 'Docs', ['docs']],
            ['docs/ai', 'AI Plugins', ['docs/ai', 'docs/ai/quickstart']],
            ['docs/framework', 'Framework', ['docs/framework']],
            ['docs/framework/getting-started', 'Framework / Getting Started', ['docs/framework/getting-started', 'docs/framework/getting-started/setup']],
            ['docs/framework/core-plugins', 'Framework / Core Plugins', ['docs/framework/core-plugins', 'docs/framework/core-plugins/chat', 'docs/framework/core-plugins/router']],
        ]);
    });

    it('splits doc families under a locale prefix too', () => {
        const out = groupLlmsSections(entries([
            ['fr', 'Accueil — Site'],
            ['fr/docs', 'Documentation — Site'],
            ['fr/docs/ai', 'Plugins IA — Site'],
            ['fr/docs/ai/quickstart', 'Démarrage — Site'],
            ['fr/docs/framework', 'Framework — Site'],
            ['fr/docs/framework/router', 'Router — Site'],
        ]), 'Site');
        expect(shape(out).map(([key, label]) => [key, label])).toEqual([
            ['fr', 'Fr'],
            ['fr/docs/ai', 'Fr / Plugins IA'],
            ['fr/docs/framework', 'Fr / Framework'],
        ]);
    });

    it('labels by slug when the page title is only the site name or the path', () => {
        const out = groupLlmsSections(entries([
            ['docs/guides', 'Manifest'],
            ['docs/guides/one', 'One'],
            ['docs/api-reference', 'docs/api-reference'],
            ['docs/api-reference/auth', 'Auth'],
        ]), 'Manifest');
        expect(shape(out).map(([, label]) => label)).toEqual(['Guides', 'Api Reference']);
    });

    it('places split sections right after their parent, whatever the page order', () => {
        const out = groupLlmsSections(entries([
            ['docs', 'Docs — M'],
            ['docs/ai', 'AI — M'],
            ['docs/framework', 'Framework — M'],
            ['legal', 'Legal — M'],
            ['docs/framework/guides', 'Guides — M'],
            ['docs/framework/api', 'API — M'],
            ['docs/ai/setup', 'Setup — M'],
            ['docs/ai/projects', 'Projects — M'],
            ['docs/framework/guides/one', 'One — M'],
            ['docs/framework/api/auth', 'Auth — M'],
            ['docs/ai/setup/claude', 'Claude — M'],
            ['docs/ai/projects/edit', 'Edit — M'],
            ['legal/terms', 'Terms — M'],
        ]), 'M');
        expect([...out.values()].map((s) => s.label)).toEqual([
            'Docs', 'AI', 'AI / Setup', 'AI / Projects', 'Framework', 'Framework / Guides', 'Framework / API', 'Legal',
        ]);
    });
});
