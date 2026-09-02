/* Manifest Service Worker */

// App-shell worker (PERF-PRIMITIVES-DESIGN §13). Loaded inside a same-origin
// `/sw.js` stub via importScripts — no Alpine, no DOM. Every handler fails open:
// an exception anywhere degrades to a plain network fetch.
//
// Stub (`Manifest.swStub(version)` in the loader emits exactly this):
//   try { importScripts('https://cdn.manifestx.dev/npm/mnfst@<v>/lib/manifest.sw.min.js'); } catch (e) { importScripts('https://cdn.jsdelivr.net/npm/mnfst@<v>/lib/manifest.sw.min.js'); }
//   if (!self.__mnfstSw) self.addEventListener('activate', function () { self.registration.unregister(); });
//
// Registration URL: `/sw.js?v=<framework version>&d=<deployment hash>`.
// Caches: `mnfst-sw:<worker version>:<deployment>:<class>`; old keys pruned on activate.

(function () {
'use strict';

// Build stamps the published version here; unstamped (dev) falls back to the
// registration URL's `v`, then 'dev'.
const BUILD_VERSION = '0.5.195';
const CACHE_PREFIX = 'mnfst-sw:';
const META_CACHE = CACHE_PREFIX + 'meta';
const SWR_CAP = 200;
const PRECACHE_PATH = '/precache.json';
const PRECACHE_CONCURRENCY = 4;

const STATIC_EXT = /\.(css|js|mjs|json|csv|tsv|ya?ml|md|txt|xml|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|wasm|webmanifest|map)$/i;
const SKIP_PATH = /^\/(sw\.js$|precache\.json$|v1\/|_appwrite\/|_ai\/|__mnfst|__edit)/;
const CDN_HOST = /^(cdn\.manifestx\.dev|cdn\.jsdelivr\.net|unpkg\.com|esm\.run)$/;
const ICONIFY_HOST = /^api\.(iconify\.design|simplesvg\.com|unisvg\.com)$/;
const EXACT_PIN = /@\d+\.\d+\.\d+[^/]*(\/|$)/;
const ANY_PIN = /@[^/]+(\/|$)/;

let metaPromise = null;

function queryParam(name) {
	try { return new URL(self.location.href).searchParams.get(name) || ''; } catch (_) { return ''; }
}

function defaultMeta() {
	const version = BUILD_VERSION.indexOf('-dev') === -1 ? BUILD_VERSION : (queryParam('v') || 'dev');
	return { version, deployment: queryParam('d') };
}

function keyOf(meta) { return CACHE_PREFIX + meta.version + ':' + (meta.deployment || '-') + ':'; }

// Deployment hash: manifest.json `deployment` wins, else the registration URL's `d`.
async function computeMeta() {
	const meta = defaultMeta();
	try {
		const res = await fetch('/manifest.json', { cache: 'no-store' });
		if (res.ok) {
			const json = await res.json();
			if (json && typeof json.deployment === 'string' && json.deployment) meta.deployment = json.deployment;
		}
	} catch (_) { /* offline install keeps the URL hash */ }
	try {
		const cache = await caches.open(META_CACHE);
		await cache.put('/__meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
	} catch (_) { /* meta persistence is best-effort */ }
	return meta;
}

// Persisted at install so a restarted worker keys caches identically.
function getMeta() {
	if (!metaPromise) {
		metaPromise = (async () => {
			try {
				const cache = await caches.open(META_CACHE);
				const hit = await cache.match('/__meta');
				if (hit) {
					const meta = await hit.json();
					if (meta && meta.version) return meta;
				}
			} catch (_) { /* fall through */ }
			return computeMeta();
		})().catch(() => defaultMeta());
	}
	return metaPromise;
}

async function openClass(cls) {
	const meta = await getMeta();
	return caches.open(keyOf(meta) + cls);
}

// URL → strategy: 'document' | 'manifest' | 'immutable' | 'swr' | null (pass-through).
function classify(request) {
	if (request.method !== 'GET') return null;
	if (request.headers.has('range')) return null;
	if ((request.headers.get('accept') || '').indexOf('text/event-stream') !== -1) return null;
	const url = new URL(request.url);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	const sameOrigin = url.origin === self.location.origin;
	const path = url.pathname;

	if (request.mode === 'navigate' || request.destination === 'document') return sameOrigin ? 'document' : null;

	if (sameOrigin) {
		if (SKIP_PATH.test(path)) return null;
		if (/(^|\/)manifest\.json$/.test(path)) return 'manifest';
		if (url.searchParams.get('v')) return 'immutable';
		if (/\.html?$/i.test(path)) return 'document';
		if (STATIC_EXT.test(path)) return 'swr';
		return null;
	}

	if (ICONIFY_HOST.test(url.host)) return /\.json$/.test(path) ? 'immutable' : null;
	if (!CDN_HOST.test(url.host)) return null;
	if (EXACT_PIN.test(path) || /\/alpinejs@/.test(path)) return 'immutable';
	if (ANY_PIN.test(path)) return 'swr';
	return null;
}

function cacheable(response) {
	return !!response && response.ok && !response.redirected && (response.type === 'basic' || response.type === 'cors' || response.type === 'default');
}

// Cross-origin script tags fetch no-cors (opaque, uncheckable); refetch with
// CORS so only real 200s are cached. A CORS failure falls back to pass-through.
function cacheFetch(request) {
	const url = new URL(request.url);
	if (url.origin === self.location.origin || request.mode === 'cors') return fetch(request);
	return fetch(new Request(request.url, { mode: 'cors', credentials: 'omit', redirect: 'follow' }));
}

async function trimSwr(cache) {
	const keys = await cache.keys();
	const excess = keys.length - SWR_CAP;
	for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function fromCacheFirst(request) {
	const cache = await openClass('assets');
	const hit = await cache.match(request);
	if (hit) return hit;
	const response = await cacheFetch(request);
	if (cacheable(response)) await cache.put(request, response.clone());
	return response;
}

async function fromSwr(request, event) {
	const cache = await openClass('swr');
	const hit = await cache.match(request);
	const refresh = (async () => {
		const response = await cacheFetch(request);
		if (cacheable(response)) {
			await cache.put(request, response.clone());
			await trimSwr(cache);
		}
		return response;
	})();
	if (hit) {
		event.waitUntil(refresh.catch(() => { }));
		return hit;
	}
	return refresh;
}

async function fromNetworkFirst(request, isDocument) {
	const cache = await openClass('pages');
	try {
		const response = await fetch(request);
		if (cacheable(response)) await cache.put(request, response.clone());
		return response;
	} catch (err) {
		const hit = await cache.match(request, { ignoreSearch: isDocument });
		if (hit) return hit;
		if (isDocument && request.mode === 'navigate') {
			const shell = (await cache.match('/index.html')) || (await cache.match('/'));
			if (shell) return shell;
		}
		throw err;
	}
}

function handle(event, strategy) {
	const request = event.request;
	switch (strategy) {
		case 'immutable': return fromCacheFirst(request);
		case 'swr': return fromSwr(request, event);
		case 'document': return fromNetworkFirst(request, true);
		case 'manifest': return fromNetworkFirst(request, false);
		default: return fetch(request);
	}
}

async function pruneCaches(meta) {
	const keep = keyOf(meta);
	const names = await caches.keys();
	await Promise.all(names
		.filter(n => n.indexOf(CACHE_PREFIX) === 0 && n !== META_CACHE && n.indexOf(keep) !== 0)
		.map(n => caches.delete(n)));
}

async function clearAll() {
	const names = await caches.keys();
	await Promise.all(names.filter(n => n.indexOf(CACHE_PREFIX) === 0).map(n => caches.delete(n)));
}

// precache.json: { "deployment": "<hash>", "files": ["/index.html", "/components/x.html?v=<hash>", …] }
// Warms in the background; any failure is ignored. Skipped when the list is
// for another deployment (a newer worker is on its way).
async function warmPrecache(meta) {
	let list;
	try {
		const res = await fetch(PRECACHE_PATH, { cache: 'no-store' });
		if (!res.ok) return;
		list = await res.json();
	} catch (_) { return; }
	if (!list || !Array.isArray(list.files)) return;
	if (list.deployment && meta.deployment && list.deployment !== meta.deployment) return;
	const files = list.files.filter(f => typeof f === 'string');
	const one = async (file) => {
		try {
			const request = new Request(new URL(file, self.location.origin).href);
			const strategy = classify(request);
			if (!strategy) return;
			const cls = strategy === 'immutable' ? 'assets' : strategy === 'swr' ? 'swr' : 'pages';
			const cache = await openClass(cls);
			if (await cache.match(request)) return;
			const response = await cacheFetch(request);
			if (cacheable(response)) await cache.put(request, response);
		} catch (_) { /* best effort */ }
	};
	let i = 0;
	const worker = async () => { while (i < files.length) await one(files[i++]); };
	await Promise.all(Array.from({ length: PRECACHE_CONCURRENCY }, worker));
}

// Activation self-check: unregister when the runtime cannot host this module.
function healthy() {
	return !!(self.registration && typeof caches !== 'undefined' && typeof fetch === 'function' && self.__mnfstSw === MODULE);
}

const MODULE = { version: defaultMeta().version, ready: true };
self.__mnfstSw = MODULE;

self.addEventListener('install', (event) => {
	try {
		metaPromise = null;
		event.waitUntil(computeMeta().then(m => { metaPromise = Promise.resolve(m); }).catch(() => { }));
	} catch (_) { /* install proceeds */ }
});

// No skipWaiting: a new worker activates on the next navigation, never under a live tab.
self.addEventListener('activate', (event) => {
	try {
		event.waitUntil((async () => {
			if (!healthy()) { await self.registration.unregister(); return; }
			const meta = await getMeta();
			await pruneCaches(meta).catch(() => { });
			warmPrecache(meta).catch(() => { });
		})().catch(() => { }));
	} catch (_) { /* activation proceeds */ }
});

self.addEventListener('fetch', (event) => {
	let strategy = null;
	try { strategy = classify(event.request); } catch (_) { return; }
	if (!strategy) return;
	try {
		event.respondWith(handle(event, strategy).catch(() => fetch(event.request)));
	} catch (_) { /* respondWith already settled or unavailable → browser fetches */ }
});

// Message API: { type: 'manifest:sw', action: 'ping' | 'version' | 'kill' }.
self.addEventListener('message', (event) => {
	try {
		const data = event.data;
		if (!data || data.type !== 'manifest:sw') return;
		const reply = (msg) => {
			try {
				const port = event.ports && event.ports[0];
				if (port) port.postMessage(msg);
				else if (event.source && event.source.postMessage) event.source.postMessage(msg);
			} catch (_) { /* no channel */ }
		};
		if (data.action === 'ping') { reply({ type: 'manifest:sw', action: 'pong' }); return; }
		if (data.action === 'version') {
			event.waitUntil(getMeta().then(meta => reply({ type: 'manifest:sw', action: 'version', version: meta.version, deployment: meta.deployment, key: keyOf(meta) })).catch(() => { }));
			return;
		}
		if (data.action === 'kill') {
			event.waitUntil((async () => {
				await clearAll().catch(() => { });
				await self.registration.unregister().catch(() => { });
				reply({ type: 'manifest:sw', action: 'killed' });
			})().catch(() => { }));
		}
	} catch (_) { /* ignore */ }
});

})();
