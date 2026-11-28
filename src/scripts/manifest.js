/*  Manifest JS
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Loader: pulls Alpine.js and Manifest plugins from the jsDelivr CDN — all
/*  plugins by default, or a subset if specified.
*/

(function () {
	'use strict';

	const loaderScript = document.currentScript;

	// Pending work that will still change the page: plugins hold() until their DOM update lands; mnfst-render's auto settle won't snapshot early while count > 0
	if (!window.ManifestPending) {
		const holds = new Map();
		let seq = 0;
		window.ManifestPending = {
			hold(label = 'work') {
				const id = ++seq;
				holds.set(id, label);
				return () => { holds.delete(id); };
			},
			get count() {
				return holds.size + (window.__manifestMarkdownPending || 0) + (window.__manifestUtilitiesPending || 0);
			},
			labels() {
				const out = [...holds.values()];
				if (window.__manifestMarkdownPending > 0) out.push('markdown');
				if (window.__manifestUtilitiesPending > 0) out.push('utilities');
				return out;
			},
			// Marks a timer callback as housekeeping that never changes the page; prerender doesn't wait for it
			background(fn) {
				if (typeof fn === 'function') fn.__manifestBackground = true;
				return fn;
			},
		};
	}

	/*
	 * Hydration contract runtime: prerendered MPA pages carry a `#__manifest_hydrate__`
	 * diff of source-authored attributes (and data-hydrate innerHTML). Applied once
	 * BEFORE any plugin or Alpine so downstream code sees the authored DOM, as in a
	 * live SPA. Attributes go through an HTML parse — setAttribute throws on `@click`.
	 */
	function hydratePrerenderedPage() {
		if (typeof document === 'undefined' || !document.querySelector) return;
		// Only run on pages the prerender marked as static MPA output.
		const prerenderMeta = document.querySelector('meta[name="manifest:prerendered"]');
		if (!prerenderMeta || prerenderMeta.getAttribute('content') === '0') return;

		const blob = document.getElementById('__manifest_hydrate__');
		if (!blob) return;
		let entries;
		try {
			entries = JSON.parse(blob.textContent || '[]');
		} catch (_) {
			entries = [];
		}
		if (!Array.isArray(entries) || entries.length === 0) {
			blob.remove();
			return;
		}
		const escAttr = (s) => String(s == null ? '' : s)
			.replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;');
		const voidEls = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

		// Deepest-first: a rebuilt ancestor then captures already-restored children.
		const items = [];
		for (const entry of entries) {
			const el = document.querySelector('[data-hydrate-id="' + entry.id + '"]');
			if (!el) continue;
			let depth = 0;
			for (let p = el.parentNode; p; p = p.parentNode) depth++;
			items.push({ entry, el, depth });
		}
		items.sort((a, b) => b.depth - a.depth);

		for (const { entry, el: initialEl } of items) {
			const el = document.querySelector('[data-hydrate-id="' + entry.id + '"]') || initialEl;
			if (!el || !el.parentNode) continue;

			// Case 1: explicit subtree restoration (entry.html present) —
			// rebuild via outerHTML so the whole subtree mirrors source.
			if (typeof entry.html === 'string') {
				const tag = el.tagName.toLowerCase();
				const finalAttrs = {};
				// Current attrs, then the contract diff.
				const cur = el.attributes;
				for (let i = 0; i < cur.length; i++) {
					if (cur[i].name !== 'data-hydrate-id') finalAttrs[cur[i].name] = cur[i].value;
				}
				if (entry.attrs) {
					for (const name in entry.attrs) {
						const v = entry.attrs[name];
						if (v === null) delete finalAttrs[name];
						else finalAttrs[name] = v;
					}
				}
				const attrString = Object.keys(finalAttrs)
					.map((n) => n + '="' + escAttr(finalAttrs[n]) + '"')
					.join(' ');
				const isVoid = voidEls.has(tag);
				const newHTML = isVoid
					? '<' + tag + ' ' + attrString + '>'
					: '<' + tag + ' ' + attrString + '>' + entry.html + '</' + tag + '>';
				const tmp = document.createElement('div');
				tmp.innerHTML = newHTML;
				const parsed = tmp.firstElementChild;
				if (parsed) {
					try { el.parentNode.replaceChild(parsed, el); } catch (_) { }
				}
				continue;
			}

			// Case 2: attribute-only diff. Reparse with merged attrs (so
			// special names like @click work); innerHTML preserved.
			if (!entry.attrs) continue;
			const tag = el.tagName.toLowerCase();
			const finalAttrs = {};
			const cur = el.attributes;
			for (let i = 0; i < cur.length; i++) {
				if (cur[i].name !== 'data-hydrate-id') finalAttrs[cur[i].name] = cur[i].value;
			}
			for (const name in entry.attrs) {
				const v = entry.attrs[name];
				if (v === null) delete finalAttrs[name];
				else finalAttrs[name] = v;
			}
			const attrString = Object.keys(finalAttrs)
				.map((n) => n + '="' + escAttr(finalAttrs[n]) + '"')
				.join(' ');
			const isVoid = voidEls.has(tag);
			const innerHTML = isVoid ? '' : el.innerHTML;
			const newHTML = isVoid
				? '<' + tag + ' ' + attrString + '>'
				: '<' + tag + ' ' + attrString + '>' + innerHTML + '</' + tag + '>';
			const tmp = document.createElement('div');
			tmp.innerHTML = newHTML;
			const parsed = tmp.firstElementChild;
			if (parsed) {
				try { el.parentNode.replaceChild(parsed, el); } catch (_) { }
			}
		}

		blob.remove();
	}

	/*
	 * Reconcile baked x-for/x-if clones kept for crawlers — their <template> is still
	 * live, so Alpine would render duplicates. x-if clones are adopted via
	 * `_x_currentIfEl` (avoids re-rendering heavy content) and stay inert until
	 * their guard holds; x-for clones are removed.
	 * Runs on alpine:init so a page without Alpine keeps its baked content.
	 */
	const adoptedIfs = new Set();
	const adoptedTpls = new WeakSet();
	let settleQueued = false;
	function settleAdopted() {
		for (const a of [...adoptedIfs]) a.settle();
	}
	function queueSettle() {
		if (settleQueued) return;
		settleQueued = true;
		queueMicrotask(() => { settleQueued = false; settleAdopted(); });
	}
	function underIgnore(node) {
		for (let n = node.parentNode; n; n = n.parentNode) if (n._x_ignore) return true;
		return false;
	}
	function adoptIfClone(tpl, el) {
		const A = window.Alpine;
		const expr = tpl.getAttribute('x-if');
		// No Alpine root above: never walked, so the clone binds as before.
		let live = !tpl.closest('[x-data],[x-init]');
		let pending = false;
		let stopWatch = null;
		const guard = () => !!A.evaluate(tpl, expr);
		const unwatch = () => {
			if (stopWatch) { stopWatch(); stopWatch = null; }
		};
		const forget = () => {
			adoptedIfs.delete(entry);
			unwatch();
		};
		// On screen, unbound, until a settle or an outer activation.
		const park = () => {
			live = false;
			pending = false;
			unwatch();
			el._x_ignore = true;
			adoptedIfs.add(entry);
		};
		// Mirrors Alpine's x-if hide() bookkeeping.
		const undo = () => {
			forget();
			A.mutateDom(() => {
				A.destroyTree(el);
				el.remove();
			});
			delete tpl._x_currentIfEl;
			delete tpl._x_lastRenderedEl;
			queueSettle();
		};
		// Bound only while the guard holds; adopted clones inside follow.
		const activate = () => {
			if (live || tpl._x_currentIfEl !== el || !el.isConnected || underIgnore(tpl)) return;
			live = true;
			pending = false;
			forget();
			delete el._x_ignore;
			A.initTree(el);
			settleAdopted();
		};
		const watch = () => {
			if (stopWatch || !pending || tpl._x_currentIfEl !== el || underIgnore(tpl)) return;
			const check = A.evaluateLater(tpl, expr);
			const fx = A.effect(() => check((v) => { if (v) queueMicrotask(() => { if (pending && guard()) activate(); }); }));
			stopWatch = () => A.release(fx);
		};
		const entry = {
			settle() {
				if (live || pending) return;
				if (tpl._x_currentIfEl !== el) return forget();
				if (!el.isConnected) {
					// Stashed in a template (defer) waits; removed with an ancestor is dropped.
					if (!(el.getRootNode() instanceof DocumentFragment)) forget();
					return;
				}
				if (tpl._x_marker && !underIgnore(tpl) && guard()) activate();
			},
		};
		// Boot-time false (e.g. data still loading) keeps the clone on screen,
		// unbound, until the guard holds or manifest:ready — no blank frame.
		const adoptedUndo = () => {
			if (window.__manifestReady || !window.__manifestReadyCoordinator) return undo();
			queueMicrotask(() => {
				if (tpl._x_currentIfEl !== el) return;
				tpl._x_undoIf = adoptedUndo;
				watch();
			});
			// Torn down with an outer clone: its guard may no longer evaluate.
			if (underIgnore(tpl)) return park();
			if (live) {
				live = false;
				el._x_ignore = true;
				A.destroyTree(el);
				adoptedIfs.add(entry);
			}
			if (pending) return;
			pending = true;
			window.addEventListener('manifest:ready', () => {
				if (!pending || tpl._x_currentIfEl !== el) return;
				if (tpl.isConnected && underIgnore(tpl)) return park();
				if (tpl.isConnected && guard()) return activate();
				undo();
				delete tpl._x_undoIf;
			}, { once: true });
		};
		tpl._x_currentIfEl = el;
		tpl._x_lastRenderedEl = el;
		tpl._x_undoIf = adoptedUndo;
		adoptedTpls.add(tpl);
		if (!live) {
			el._x_ignore = true;
			adoptedIfs.add(entry);
		}
	}
	// Older renders marked placeholders inside x-if/x-for content; clones must swap.
	function unmarkTemplatePlaceholders(root, inside) {
		root.querySelectorAll('template').forEach((tpl) => {
			const authored = inside || tpl.matches('[x-if],[x-for]');
			if (authored) {
				tpl.content.querySelectorAll('[data-pre-rendered]').forEach((el) => {
					if (el.tagName.startsWith('X-')) el.removeAttribute('data-pre-rendered');
				});
			}
			unmarkTemplatePlaceholders(tpl.content, authored);
		});
	}
	function reconcilePrerenderClones() {
		if (typeof document === 'undefined' || !document.querySelectorAll) return;
		unmarkTemplatePlaceholders(document);
		let adopted = 0;
		document.querySelectorAll('[data-mnfst-prerender-clone]').forEach((el) => {
			if (el.closest && el.closest('[data-hydrate]')) return;
			el.removeAttribute('data-mnfst-prerender-clone');
			const tpl = el.previousElementSibling;
			if (tpl && tpl.tagName === 'TEMPLATE' && tpl.hasAttribute('x-if')) {
				// Alpine's x-if show() returns early when _x_currentIfEl is set.
				adoptIfClone(tpl, el);
				adopted++;
			} else {
				el.remove();
			}
		});
		if (!adopted) return;
		const A = window.Alpine;
		// Templates walked after start (deferred subtrees) settle once their x-if ran.
		if (typeof A.interceptInit === 'function') {
			A.interceptInit((node) => {
				if (adoptedTpls.has(node) && adoptedIfs.size) queueSettle();
			});
		}
		document.addEventListener('alpine:initialized', settleAdopted, { once: true });
	}
	if (typeof document !== 'undefined') {
		document.addEventListener('alpine:init', reconcilePrerenderClones, { once: true });
	}

	// Run hydration BEFORE Alpine's deferred script executes: DOMContentLoaded
	// is too late (Alpine has already bound the nodes our replaceChild would
	// destroy). The earlier `readystatechange → 'interactive'` fires the moment
	// parsing finishes, before deferred scripts. Run synchronously if already
	// past 'loading' (e.g. manifest.js injected after load).
	function tryHydrate() {
		try { hydratePrerenderedPage(); } catch (e) { /* graceful */ }
	}
	if (typeof document !== 'undefined') {
		if (document.readyState === 'loading') {
			// Still parsing: 'interactive' is the earliest hook where body exists
			// but deferred scripts haven't run.
			let hydrated = false;
			document.addEventListener('readystatechange', () => {
				if (!hydrated && document.readyState !== 'loading') {
					hydrated = true;
					tryHydrate();
				}
			});
		} else {
			// Parser already done — hydrate immediately.
			tryHydrate();
		}
	}

	// Mark <html> with .window-resizing while the viewport is being resized so
	// CSS can suspend layout-tracking transitions (e.g. the tab bar slider)
	if (typeof window !== 'undefined' && typeof document !== 'undefined') {
		let resizeIdleTimer = null;
		window.addEventListener('resize', () => {
			document.documentElement.classList.add('window-resizing');
			if (resizeIdleTimer) clearTimeout(resizeIdleTimer);
			resizeIdleTimer = setTimeout(() => {
				document.documentElement.classList.remove('window-resizing');
				resizeIdleTimer = null;
			}, 200);
		}, { passive: true });
	}

	// Configuration
	const DEFAULT_VERSION = 'latest';

	// Stamped at build
	const LOADER_VERSION = '0.0.0-dev';
	const MODULES_INTEGRITY = '';
	const INTEGRITY_FILE = 'manifest.modules.integrity.json';
	const VENDOR_FILE = 'manifest.vendor.integrity.json';
	// 'strict' | 'warn' while checks are requested; map promise while they apply
	let integrityMode = null;
	let integrityReady = null;
	let integrityActive = false;
	let alpineIntegrity = null;

	// The version the page booted with (data-version). Every later load —
	// Manifest.loadPlugin(), usage sniffing — resolves against it, so a runtime
	// load can't pull a second copy of the framework at another version.
	let RESOLVED_VERSION = DEFAULT_VERSION;

	// CDN fallback chain (first-party first). Each origin serves the npm scheme
	// `<origin>/<pkg>@<version>/<path>`. Override order with `data-cdn`
	// (comma-separated origins).
	let CDN_HOSTS = [
		'https://cdn.manifestx.dev/npm',
		'https://cdn.jsdelivr.net/npm',
		'https://unpkg.com'
	];
	function setCdnHosts(value) {
		if (!value) return;
		const hosts = value.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
		if (hosts.length) CDN_HOSTS = hosts;
	}

	// unpkg doesn't auto-minify; mnfst versions before the integrity release ship only .js
	function hostFile(host, file) {
		return host.includes('unpkg.com') ? file.replace(/\.min\.js$/, '.js') : file;
	}

	// Get base URL for a given version
	function getBaseUrl(version = DEFAULT_VERSION, host = CDN_HOSTS[0]) {
		return `${host}/mnfst@${version}/lib`;
	}

	// Available core plugins (auto-loaded if no data-plugins specified)
	const AVAILABLE_PLUGINS = [
		'components',
		'router',
		'utilities',
		'data',
		'icons',
		'localization',
		'color',
		'toasts',
		'tooltips',
		'dropdowns',
		'computed',
		'tabs',
		'url-parameters',
		'status'
	];

	// Always-on behaviours (not plugins, never listed, cannot be omitted): closed
	// containers stay inert until opened; text bindings only write on change.
	// Kill switches: data-defer="off" on the loader script.
	const ALWAYS_ON = ['defer', 'bindings'];

	// Authoring plugin — opt-in only. Visitors should never pay for editor chrome;
	// load it with data-plugins or Manifest.loadPlugin('edit') behind your own gate.
	const AUTHORING_PLUGINS = ['edit'];

	// Appwrite integration plugins (opt-in only, never auto-loaded)
	const APPWRITE_PLUGINS = [
		'appwrite-auth',
		'appwrite-data',
		'appwrite-presences'
	];

	// Loaded on use (see USAGE_PLUGINS), with data-modules, or as a dependency
	const USAGE_LOADED_PLUGINS = ['rich-text', 'submissions', 'markdown', 'svg', 'code', 'combobox', 'slides', 'colorpicker', 'datepicker', 'charts', 'virtual', 'export'];

	// Plugin dependencies: plugins that require other plugins to be loaded first
	const PLUGIN_DEPENDENCIES = {
		'appwrite-data': ['data'],
		'appwrite-presences': ['data', 'appwrite-auth'],
		'device': ['utilities'],
		'edit': ['rich-text']
	};

	// Derive default plugin list from manifest (only load data/localization/components when manifest needs them)
	function getDefaultPluginsFromManifest(manifest) {
		if (!manifest || typeof manifest !== 'object') {
			return AVAILABLE_PLUGINS.slice();
		}
		const hasData = manifest.data && typeof manifest.data === 'object' && Object.keys(manifest.data).length > 0;
		const hasComponents = (manifest.components?.length > 0) || (manifest.preloadedComponents?.length > 0);
		const hasLocalization = (() => {
			if (!manifest.data || typeof manifest.data !== 'object') return false;
			for (const collection of Object.values(manifest.data)) {
				if (!collection || typeof collection !== 'object') continue;
				if (typeof collection.locales === 'string') return true;
				for (const key of Object.keys(collection)) {
					if (['url', 'headers', 'params', 'transform', 'defaultValue', 'locales'].includes(key)) continue;
					if (/^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(key)) return true;
				}
			}
			return false;
		})();
		const hasStatus = manifest.status && typeof manifest.status === 'object' && Object.keys(manifest.status).length > 0;
		return AVAILABLE_PLUGINS.filter(p => {
			if (p === 'data') return hasData;
			if (p === 'localization') return hasLocalization;
			if (p === 'components') return hasComponents;
			if (p === 'status') return hasStatus;
			return true;
		});
	}

	// Plugin URLs: `data-plugin-base` override → single unminified `.js` (no
	// fallback — an explicit base, e.g. local dev, must fail loudly); else one
	// candidate per CDN host, tried in order.
	let _pluginBase = null;
	function setPluginBase(b) { _pluginBase = b || null; }
	// data-omit: never loaded by the loader itself, unless a loaded module depends on it (Manifest.loadPlugin still can)
	let _omitted = [];
	const notOmitted = (list) => _omitted.length ? list.filter(p => !_omitted.includes(p)) : list;
	function getPluginUrlCandidates(pluginName, version = RESOLVED_VERSION) {
		// Hyphenated API name → dotted file name (`appwrite-auth` → appwrite.auth).
		const fileName = pluginName.replace(/-/g, '.');
		if (_pluginBase) {
			const base = _pluginBase.replace(/\/$/, '');
			return [`${base}/manifest.${fileName}.js`];
		}
		return CDN_HOSTS.map(h => `${getBaseUrl(version, h)}/${hostFile(h, `manifest.${fileName}.min.js`)}`);
	}
	function getPluginUrl(pluginName, version = RESOLVED_VERSION) {
		return getPluginUrlCandidates(pluginName, version)[0];
	}

	// Alpine URL candidates from a data-alpine value (version tag, full URL, or same-origin path)
	// Tested version, kept equal to package.json; re-evaluated on each major framework release
	const DEFAULT_ALPINE_VERSION = '3.17.5';
	function alpineUrlCandidates(dataAlpine) {
		if (dataAlpine && (dataAlpine.startsWith('http') || dataAlpine.startsWith('/'))) return [dataAlpine];
		const v = dataAlpine || DEFAULT_ALPINE_VERSION;
		return CDN_HOSTS.map(h => `${h}/alpinejs@${v}/dist/cdn.min.js`);
	}

	// Has DOMContentLoaded fired? readyState can't tell ('interactive' spans
	// both DCL-pending and DCL-done); the navigation timing entry disambiguates.
	// Its end stays 0 while DCL listeners run: seen here first, so code run from them doesn't wait for load
	let dclStarted = false;
	if (typeof document !== 'undefined' && document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', () => { dclStarted = true; }, { once: true });
	function domContentLoadedFired() {
		if (dclStarted || document.readyState === 'complete') return true;
		if (document.readyState === 'loading') return false;
		try {
			const nav = performance.getEntriesByType('navigation')[0];
			if (nav) return nav.domContentLoadedEventEnd > 0;
		} catch (_) { /* fall through */ }
		return false;
	}

	// Run fn at or after DOMContentLoaded; 'load' is a fallback when the
	// navigation entry is missing.
	function whenDomReady(fn) {
		if (domContentLoadedFired()) {
			fn();
			return;
		}
		let done = false;
		const run = () => { if (!done) { done = true; fn(); } };
		document.addEventListener('DOMContentLoaded', run, { once: true });
		window.addEventListener('load', run, { once: true });
	}

	// Load Alpine, called after all plugins have registered. Gated on DCL: a
	// warm-cache Alpine could otherwise execute between two deferred scripts and
	// fire `alpine:init` before the page's registrations exist. DCL fires only
	// after every deferred script runs, making the order deterministic (and cold
	// cache is already past DCL, so no added delay).
	function loadAlpine(alpineUrls) {
		whenDomReady(() => {
			if (window.Alpine) {
				return;
			}

			// Don't inject a second copy if an Alpine <script> is already present.
			const existingAlpine = document.querySelector('script[src*="alpinejs"]');
			if (existingAlpine) {
				return;
			}

			// Past DCL, so each candidate executes as soon as it arrives; fall
			// through the CDN chain on error.
			injectFrom(alpineUrls, { alpine: true }).catch((e) => {
				if (!e.logged) console.error('[Manifest Loader] Alpine.js failed to load from all CDNs.');
			});
		});
	}

	// Inject one script URL and wait for it to load and execute
	// Has an existing script tag already executed? Loader-injected tags are marked on load;
	// a parser-inserted classic tag ahead of the loader ran before it; a resource-timing
	// entry means the fetch finished; a complete document has run every parser tag.
	function scriptSettled(el) {
		if (el.hasAttribute('data-mnfst-loaded')) return true;
		if (el.hasAttribute('data-mnfst-loading')) return false;   // ours, still fetching or executing: only its load event counts
		if (document.readyState === 'complete') return true;
		if (!el.async && !el.defer && loaderScript && (loaderScript.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) return true;
		try { if (el.src && performance.getEntriesByName(el.src).length) return true; } catch (_) { /* no resource timing */ }
		return false;
	}

	function injectScript(url, integrity, ordered = true, priority = null) {
		return new Promise((resolve, reject) => {
			// Same src already in the DOM (author tag, prerendered HTML, second loader run)
			const existing = document.querySelector(`script[src="${url}"]`);
			if (existing) {
				if (scriptSettled(existing)) return resolve();
				let done = false;
				const finish = () => { if (!done) { done = true; resolve(); } };
				existing.addEventListener('load', finish);
				existing.addEventListener('error', () => { if (!done) { done = true; reject(new Error(`Failed to load ${url}`)); } });
				// A tag that already fired never fires again — never let boot hang on it
				const poll = setInterval(() => { if (scriptSettled(existing)) { clearInterval(poll); finish(); } }, 50);
				setTimeout(() => { clearInterval(poll); finish(); }, 4000);
				return;
			}

			const script = document.createElement('script');
			if (integrity) {
				script.integrity = integrity;
				script.crossOrigin = 'anonymous';
			}
			if (priority) script.setAttribute('fetchpriority', priority);
			script.src = url;
			script.async = !ordered; // Modules execute in order; third-party files as they arrive
			script.setAttribute('data-mnfst-loading', '');
			script.onload = () => { script.removeAttribute('data-mnfst-loading'); script.setAttribute('data-mnfst-loaded', ''); resolve(); };
			script.onerror = () => { script.removeAttribute('data-mnfst-loading'); script.remove(); reject(new Error(`Failed to load ${url}`)); };
			document.head.appendChild(script);
		});
	}

	// Subresource Integrity: hashes from the published map, verified against MODULES_INTEGRITY
	function fileOf(url) {
		return url.split(/[?#]/)[0].split('/').pop();
	}
	function alpineKey(url) {
		const m = url.match(/(alpinejs@[^/]+\/dist\/cdn\.min\.js)(?:[?#]|$)/);
		return m ? m[1] : null;
	}
	// A 200 that errored was refused on its hash (Chromium only)
	function refusedOnHash(url) {
		try {
			const e = performance.getEntriesByName(new URL(url, location.href).href).pop();
			return !!e && e.responseStatus === 200;
		} catch (_) { return false; }
	}
	// Strict mode refuses (error, throws); warn mode logs and goes on unchecked
	function integrityProblem(message, refused) {
		if (integrityMode === 'warn') {
			console.warn(`[Manifest Loader] ${message} Loading unchecked (data-integrity="warn").`);
			return;
		}
		console.error(`[Manifest Loader] ${message} ${refused} data-integrity="warn" loads it unchecked instead.`);
		throw Object.assign(new Error(message), { logged: true });
	}

	// First candidate that answers ok (and matches its hash, when given)
	async function verifiedFetch(urls, hash, label) {
		for (const url of urls) {
			try {
				const res = await fetch(url, hash ? { integrity: hash, mode: 'cors', credentials: 'omit' } : { mode: 'cors', credentials: 'omit' });
				if (res.ok) return res;
			} catch (_) { /* network, CORS or hash mismatch */ }
			console.error(`[Manifest Loader] ${label} failed to load${hash ? ' or failed its integrity check' : ''} from ${url}`);
		}
		throw new Error(`${label} could not be ${hash ? 'verified' : 'loaded'} from any CDN${hash ? ` (expected ${hash})` : ''}.`);
	}

	async function loadIntegrity(cfg) {
		if (!MODULES_INTEGRITY) {
			console.warn('[Manifest Loader] Integrity checks need a built loader (lib/manifest.js); modules load unchecked.');
			return null;
		}
		if (cfg.version !== LOADER_VERSION) {
			integrityProblem(`Integrity checks cover this loader's own version (${LOADER_VERSION}), but data-version is "${cfg.version}". Set data-version="${LOADER_VERSION}" or remove it.`, 'No modules were loaded.');
			return null;
		}
		const urls = _pluginBase
			? [`${_pluginBase.replace(/\/$/, '')}/${INTEGRITY_FILE}`]
			: CDN_HOSTS.map(h => `${getBaseUrl(LOADER_VERSION, h)}/${INTEGRITY_FILE}`);
		try {
			return await (await verifiedFetch(urls, MODULES_INTEGRITY, INTEGRITY_FILE)).json();
		} catch (e) {
			throw new Error(`${e.message} No modules were loaded.`);
		}
	}

	// Grammar and locale-pack hashes live in a second map, fetched the first time one is needed
	let vendorFamily = null;
	const SRI_VALUE = /^sha(256|384|512)-[A-Za-z0-9+/=]+$/;
	// Own entries holding a hash only ("constructor" and friends are missing, not inherited)
	function entry(map, key) {
		const v = map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
		return typeof v === 'string' && SRI_VALUE.test(v) ? v : null;
	}
	async function hashOf(map, key) {
		const own = entry(map, key);
		if (own) return own;
		const familyHash = entry(map, VENDOR_FILE);
		if (!familyHash || !/\/(languages|langs)\//.test(key)) return null;
		if (!vendorFamily) {
			vendorFamily = verifiedFetch(CDN_HOSTS.map(h => `${getBaseUrl(LOADER_VERSION, h)}/${VENDOR_FILE}`), familyHash, VENDOR_FILE)
				.then(r => r.json())
				.catch(e => { vendorFamily = null; throw e; });
		}
		return entry(await vendorFamily, key);
	}

	// First candidate that loads (and matches its hash). A fallback insert lands after
	// already-inserted scripts: execution order is traded for availability.
	// key: map entry for every candidate (third-party files); hash: the caller's own pin when checks are off.
	async function injectFrom(urls, { key = null, hash: pinned = null, alpine = false, unchecked = false, ordered = true, priority = null } = {}) {
		const map = integrityReady && !unchecked ? await integrityReady : null;
		const file = key || fileOf(urls[0] || '');
		let lastErr = null;
		for (const url of urls) {
			let hash = pinned;
			if (map) {
				const k = key || (alpine ? alpineKey(url) : fileOf(url));
				hash = (k && await hashOf(map, k)) || (alpine ? alpineIntegrity : null);
				if (!hash) {
					if (alpine) integrityProblem(`No integrity hash is known for Alpine at ${url}. Add data-alpine-integrity="sha384-…" for it, or remove data-alpine to use the default.`, 'Alpine was not loaded.');
					else integrityProblem(`${k || url} has no integrity hash in this release.`, 'Not loaded.');
				}
			}
			try {
				return await injectScript(url, hash, ordered, priority);
			} catch (e) {
				lastErr = e;
				if (hash) console.error(`[Manifest Loader] ${fileOf(url)} ${refusedOnHash(url) ? 'failed its integrity check' : 'failed to load or failed its integrity check'} from ${url}${urls.length > 1 ? ' — trying next CDN' : ''}`);
				else if (urls.length > 1) console.warn(`[Manifest Loader] ${url} failed — trying fallback CDN`);
			}
		}
		if (map) console.error(`[Manifest Loader] ${file} did not match its integrity hash on any CDN — not loaded.`);
		throw lastErr || new Error(`Failed to load ${file}`);
	}

	// Pinned third-party files for plugins (npm path, e.g. marked@15.0.12/marked.min.js)
	function loadVendor(path, hash) {
		return injectFrom(CDN_HOSTS.map(h => `${h}/${path}`), { key: path, hash, ordered: false });
	}
	async function fetchVendor(path, pinned) {
		const map = integrityReady ? await integrityReady : null;
		let hash = pinned || null;
		if (map) {
			hash = await hashOf(map, path);
			if (!hash) integrityProblem(`${path} has no integrity hash in this release.`, 'Not loaded.');
		}
		return verifiedFetch(CDN_HOSTS.map(h => `${h}/${path}`), hash, path);
	}

	async function fetchPluginScript(pluginName, version, ordered = true) {
		let unchecked = false;
		if (integrityActive && version !== LOADER_VERSION) {
			integrityProblem(`Integrity checks cover this loader's own version (${LOADER_VERSION}); ${pluginName} was requested at ${version}.`, 'Not loaded.');
			unchecked = true;
		}
		// Known only once manifest.json lands, and the first view waits on them: ahead of the hinted modules
		const priority = ['components', 'data', 'localization'].includes(pluginName) ? 'high' : null;
		return injectFrom(getPluginUrlCandidates(pluginName, version), { unchecked, priority, ordered });
	}

	// One execution per plugin per page. injectScript dedupes by URL, which two
	// versions of the same plugin slip past — and a second copy of a plugin that
	// owns page-level state (utilities' style element and its order observer)
	// fights the first. A failed load is forgotten so a retry can still run.
	const pluginLoads = new Map();
	const pluginsSettled = new Set();
	// When each file ran: one 10 s give-up per module from then, however many waits share it
	const ranAt = new Map();
	const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
	const sinceRan = (p) => ranAt.has(p) ? now() - ranAt.get(p) : 0;
	const giveUpIn = (p) => Math.max(0, 10000 - sinceRan(p));

	async function addScript(pluginName, version = RESOLVED_VERSION, ordered = true) {
		const prior = pluginLoads.get(pluginName);
		if (prior) {
			if (prior.version !== version) {
				console.warn(`[Manifest Loader] ${pluginName} already loaded at ${prior.version} — ignoring request for ${version}`);
			}
			return prior.promise;
		}
		const promise = fetchPluginScript(pluginName, version, ordered);
		pluginLoads.set(pluginName, { version, promise });
		promise.then(() => { pluginsSettled.add(pluginName); ranAt.set(pluginName, now()); }, () => pluginLoads.delete(pluginName));
		return promise;
	}

	// Resolve plugin dependencies (auto-inject required dependencies)
	function resolveDependencies(pluginList) {
		const resolved = [];
		const added = new Set();

		const PLUGIN_ALIASES = { native: 'device', import: 'export' };   // native renamed 0.5.199; import ships inside export
		function addPluginWithDeps(plugin) {
			plugin = PLUGIN_ALIASES[plugin] || plugin;
			if (added.has(plugin)) return;

			const deps = PLUGIN_DEPENDENCIES[plugin];
			if (deps) {
				for (const dep of deps) {
					if (!added.has(dep)) {
						addPluginWithDeps(dep);
					}
				}
			}

			resolved.push(plugin);
			added.add(plugin);
		}

		for (const plugin of pluginList) {
			addPluginWithDeps(plugin);
		}

		return resolved;
	}

	// Detect Appwrite plugins needed from manifest.json content.
	// Returns an array of Appwrite plugin names to auto-load.
	function detectAppwritePlugins(manifest) {
		if (!manifest || typeof manifest !== 'object') return [];

		const hasAppwrite = manifest.appwrite ||
			(manifest.data && Object.values(manifest.data).some(
				item => item && typeof item === 'object' &&
					(item.appwriteTableId || item.appwriteDatabaseId || item.appwriteBucketId)
			));

		if (!hasAppwrite) return [];

		const plugins = [];
		if (manifest.appwrite?.auth) plugins.push('appwrite-auth');
		if (manifest.appwrite || (manifest.data && Object.values(manifest.data).some(
			item => item && typeof item === 'object' && item.appwriteTableId
		))) {
			plugins.push('appwrite-data');
		}
		if (manifest.appwrite?.presence || manifest.appwrite?.presences) {
			plugins.push('appwrite-presences');
		}
		return plugins;
	}

	// Detect the payments plugin from manifest.json content.
	// Opt-in / auto-loaded only when a `payments` config block is present.
	function detectPaymentsPlugins(manifest) {
		if (!manifest || typeof manifest !== 'object') return [];
		if (manifest.payments && typeof manifest.payments === 'object') return ['payments'];
		return [];
	}

	// Detect the chat plugin from manifest.json content.
	// Opt-in / auto-loaded when an `ai` (or `chat`) entry is present — an
	// object block or bare `true` (custom-adapter projects have no config).
	function detectChatPlugins(manifest) {
		if (!manifest || typeof manifest !== 'object') return [];
		if (manifest.ai || manifest.chat) return ['chat'];
		return [];
	}

	// Detect plugins from markup usage — magics written in Alpine expressions
	// with no declarative trigger (e.g. $chat driven by custom adapters).
	// Runs at DCL, before Alpine boots: scans element attributes (recursing
	// into template content, which the parser detaches) and inline scripts.
	// Rendered text is deliberately not scanned — code samples on a page
	// must not pull plugins in.
	// attr matches x-name, x-name.mod and x-name:arg (family: also x-name-*); late: held until
	// its module registers when Alpine walks it first (Rich Text and Submissions handle that themselves)
	const USAGE_PLUGINS = [
		{ magic: '$chat', plugin: 'chat' },
		{ magic: '$presence', plugin: 'appwrite-presences' },
		{ magic: '$rich', plugin: 'rich-text', attr: 'x-rich-text', family: true },
		{ plugin: 'submissions', attr: 'x-submit', family: true },
		...['$share', '$secure', '$links', '$push', '$app', '$haptics', '$biometric', '$camera'].map(magic => ({ magic, plugin: 'device' })),
		{ plugin: 'charts', attr: 'x-chart', magic: '$chart', present: 'ensureChartsPluginInitialized' },
		{ plugin: 'colorpicker', attr: 'x-colorpicker', magic: '$colorpicker', present: 'ensureColorpickerPluginInitialized' },
		{ plugin: 'datepicker', attr: 'x-date', magic: '$date', present: 'ensureDatepickerPluginInitialized' },
		{ plugin: 'combobox', attr: 'x-combobox', present: 'ensureComboboxPluginInitialized' },
		{ plugin: 'code', attr: 'x-code', present: 'ensureCodePluginInitialized' },
		{ plugin: 'code', attr: 'x-code-group', present: 'ensureCodePluginInitialized' },
		{ plugin: 'markdown', attr: 'x-markdown', present: 'ensureMarkdownPluginInitialized' },
		{ plugin: 'export', attr: 'x-export', magic: '$export', present: 'ensureExportPluginInitialized', call: true },
		{ plugin: 'export', attr: 'x-import', magic: '$import', present: 'ensureImportPluginInitialized', call: true },
		{ plugin: 'virtual', attr: 'x-virtual', magic: '$virtual', present: 'ensureVirtualPluginInitialized', methods: true },
		{ plugin: 'slides', attr: 'x-carousel', present: 'ensureSlidesPluginInitialized' },
		{ plugin: 'svg', attr: 'x-svg', present: 'ensureSvgPluginInitialized' }
	].map(u => ({ ...u, late: USAGE_LOADED_PLUGINS.includes(u.plugin) && !['rich-text', 'submissions'].includes(u.plugin), re: u.magic ? new RegExp('\\' + u.magic + '\\b') : null }));
	const USAGE_NAMES = [...new Set(USAGE_PLUGINS.map(u => u.plugin))];
	const USAGE_ATTRS = new Map(USAGE_PLUGINS.filter(u => u.attr).map(u => [u.attr, u]));
	const USAGE_FAMILIES = USAGE_PLUGINS.filter(u => u.family).map(u => [u.attr + '-', u]);
	const attrPlugin = (name) => { const u = attrEntry(name); return u && u.plugin; };
	// Usage entry for a directive attribute name, or undefined
	function attrEntry(name) {
		if (name.charCodeAt(0) !== 120 || name.charCodeAt(1) !== 45) return;
		let end = name.length;
		for (let i = 2; i < end; i++) { const c = name.charCodeAt(i); if (c === 46 || c === 58) { end = i; break; } }
		const base = end === name.length ? name : name.slice(0, end);
		const u = USAGE_ATTRS.get(base);
		if (u) return u;
		for (const [pre, entry] of USAGE_FAMILIES) if (base.startsWith(pre)) return entry;
	}
	// Plain-HTML trigger: <pre><code class="language-x"> and <code copy> (Code)
	function elementPlugin(el) {
		if (el.tagName !== 'CODE') return;
		if (el.hasAttribute('copy')) return 'code';
		const c = el.getAttribute('class');
		if (c && c.indexOf('language-') !== -1 && el.parentElement && el.parentElement.tagName === 'PRE') return 'code';
	}
	// $rich before Rich Text arrives (it loads on use, and SPA routes or component HTML can
	// need it later): an idle stand-in, so expressions never throw. Rich Text bumps `v` when
	// it registers the real magic, so effects that read $rich run again; Alpine binds magics
	// when a directive is first evaluated, so the stand-in then delegates to the real one.
	let richStubArmed = false;
	function stubRichMagic() {
		if (typeof window === 'undefined' || typeof document === 'undefined' || richStubArmed) return;
		richStubArmed = true;
		const install = () => {
			const A = window.Alpine;
			if (window.ManifestRichText || !A || !A.magic || !A.reactive || window.__manifestRichStub) return;
			const state = window.__manifestRichStub = A.reactive({ v: 0 });
			// Writes ($rich.value = …, $rich.all = …) are kept per element and applied to its field at handover
			const writes = window.__manifestRichStubWrites = [], perEl = new WeakMap();
			const deref = (r) => r && typeof r.deref === 'function' ? r.deref() : r;
			const base = { value: '', link: '', selection: null, all: {}, active: () => false, can: () => false, markdown: () => '', html: () => '' };
			const idleFor = (el) => {
				if (!perEl.has(el)) perEl.set(el, new Proxy(base, {
					get: (t, k) => { const w = writes.find(x => deref(x[0]) === el && x[1] === k); return w ? w[2] : k in t ? t[k] : (typeof k === 'string' ? () => { } : undefined); },
					// The latest write per element and key; elements gone from the page are let go
					set: (t, k, v) => {
						for (let i = writes.length - 1; i >= 0; i--) { const e = deref(writes[i][0]); if (!e || !e.isConnected || (e === el && writes[i][1] === k)) writes.splice(i, 1); }
						writes.push([typeof WeakRef === 'function' ? new WeakRef(el) : el, k, v]);
						return true;
					}
				}));
				return perEl.get(el);
			};
			A.magic('rich', (el, u) => { void state.v; return window.__manifestRichMagic ? window.__manifestRichMagic(el, u) : idleFor(el); });
		};
		document.addEventListener('alpine:init', install, { once: true });
		if (window.Alpine && window.Alpine.magic) install();
	}
	stubRichMagic();
	// $edit likewise: Edit loads behind a gate (data-plugins or Manifest.loadPlugin('edit')), so until
	// it registers, $edit is an idle stand-in; Edit bumps `v` and the stand-in delegates to it.
	let editStubArmed = false;
	function stubEditMagic() {
		if (typeof window === 'undefined' || typeof document === 'undefined' || editStubArmed) return;
		editStubArmed = true;
		const install = () => {
			const A = window.Alpine;
			if (window.__manifestEditMagic || !A || !A.magic || !A.reactive || window.__manifestEditStub) return;
			const state = window.__manifestEditStub = A.reactive({ v: 0 });
			const none = () => false;
			// Writes ($edit.onPublish = …) are kept and applied to the store at handover
			const writes = window.__manifestEditStubWrites = {};
			const idle = new Proxy({
				active: false, canUndo: false, canRedo: false, version: 0, stale: [], conflicts: [], onPublish: null, target: null,
				can: none, scope: () => null, block: () => null, patches: () => [], export: () => ({ log: [], cursor: 0 }),
				publish: () => Promise.resolve({ results: [] }), undo: () => Promise.resolve(false), redo: () => Promise.resolve(false),
				classes: new Proxy({}, { get: () => none })
			}, { get: (t, k) => k in writes ? writes[k] : k in t ? t[k] : (typeof k === 'string' ? none : undefined), set: (t, k, v) => { writes[k] = v; return true; } });
			A.magic('edit', (el, u) => { void state.v; return window.__manifestEditMagic ? window.__manifestEditMagic(el, u) : idle; });
		};
		document.addEventListener('alpine:init', install, { once: true });
		if (window.Alpine && window.Alpine.magic) install();
	}
	stubEditMagic();
	// Plugins loaded after Alpine started adopt what its first walk already passed
	if (typeof document !== 'undefined') document.addEventListener('alpine:initialized', () => { window.__manifestAlpineStarted = true; }, { once: true });
	// On-use modules not registered when Alpine walks their element: the element and its subtree
	// are held uninitialised (Alpine.deferInit, inert like a deferred container, x-cloak stays) and
	// started once, after the directive registers. Their magics answer through a forwarding
	// stand-in until the module arrives, so expressions never throw.
	const lateEntries = USAGE_PLUGINS.filter(u => u.late);
	const LATE_ATTRS = lateEntries.filter(u => u.attr).map(u => u.attr);
	// Ran before this loader: registered during alpine:init ahead of the wrappers below
	const preloaded = typeof window === 'undefined' ? [] : lateEntries.filter(u => window[u.present]).map(u => u.plugin);
	const registered = new Set();
	const waiters = new Map();
	const whenRegistered = (name) => {
		if (registered.has(name)) return Promise.resolve();
		if (!waiters.has(name)) { let resolve; const promise = new Promise(r => { resolve = r; }); waiters.set(name, { promise, resolve }); }
		return waiters.get(name).promise;
	};
	// Attributes added to live elements before their directive existed (no hold possible): re-set once it registers
	const reset = new Map();
	const warnedLate = new Set();
	const lateDirective = (attr) => { const u = attrEntry(attr); return u && u.late && !preloaded.includes(u.plugin) ? u : null; };
	// Will this module arrive? Starts its load when the page may load it on use
	const gaveUp = new Set();
	function bringLate(plugin) {
		if (usageFailed.has(plugin) || gaveUp.has(plugin)) return null;
		if (!pluginLoads.has(plugin)) {
			if (!usageSniff || _omitted.includes(plugin)) return null;
			fetchUsed(resolveDependencies([plugin]).filter(p => !usageLoaded(p)));
		}
		const load = pluginLoads.get(plugin);
		return load ? load.promise : null;
	}
	const heldEls = new WeakSet();
	// Holds not yet released (restore included), and controls an outer restore left to an inner one: outer root
	const holding = new WeakSet();
	const passedOn = new WeakMap();
	let heldCount = 0;
	let heldRelease = null;
	// Rendered from source: hidden while held so raw markdown/code never shows
	const RENDERS = ['markdown', 'code', 'svg'];
	// Form state typed while held, put back after start so x-model takes it (a real edit: input, then change)
	function snapshot(root) {
		const typed = [];
		const controls = root.matches('input, textarea, select') ? [root] : [];
		controls.push(...root.querySelectorAll('input, textarea, select'));
		for (const c of controls) {
			try {
				// Files picked while held can't be set back, only announced
				if (c.type === 'file') { if (c.files && c.files.length) typed.push([c, 'files', null]); continue; }
				// A radio the pick unchecked follows from the one it checked
				if (c.type === 'radio') { if (c.checked && !c.defaultChecked) typed.push([c, 'checked', true]); }
				else if (c.type === 'checkbox') { if (c.checked !== c.defaultChecked) typed.push([c, 'checked', c.checked]); }
				else if (c.tagName === 'SELECT') { const sel = [...c.options].map(o => o.selected); if (sel.some((s, i) => s !== c.options[i].defaultSelected)) typed.push([c, 'options', sel]); }
				else if (c.value !== c.defaultValue) typed.push([c, 'value', c.value]);
			} catch (_) { /* skipped */ }
		}
		const a = document.activeElement;
		const focus = a && root.contains(a) ? [a, a.selectionStart, a.selectionEnd] : null;
		return () => {
			// Outside the held element these edits were already seen live: stop the replay at its root
			const replay = new WeakMap();
			const stop = (e) => { if (replay.get(e) === e.currentTarget) e.stopPropagation(); };
			const plan = [];
			for (const [c, k, v] of typed) {
				try {
					// Taken over by its directive on start (e.g. a date field turned read-only): not typable there
					if (!c.isConnected || c.readOnly || c.disabled) continue;
					// Inside a nested hold still to restore: that one replays it, up to this root
					let inner = false;
					for (let n = c; n && n !== root; n = n.parentElement) if (holding.has(n)) { inner = true; break; }
					if (inner) { if (!passedOn.has(c)) passedOn.set(c, root); continue; }
					const at = passedOn.get(c) || root;
					passedOn.delete(c);
					plan.push([c, k, v, at]);
				} catch (_) { /* skipped */ }
			}
			const stops = new Set(plan.map(p => p[3]));
			stops.forEach(s => { s.addEventListener('input', stop); s.addEventListener('change', stop); });
			const fire = (c, type, at) => { const e = new Event(type, { bubbles: true }); replay.set(e, at); c.dispatchEvent(e); };
			for (const [c, k, v, at] of plan) {
				try {
					if (k === 'options') [...c.options].forEach((o, i) => { o.selected = !!v[i]; });
					else if (k !== 'files') c[k] = v;
					fire(c, 'input', at);
					fire(c, 'change', at);
				} catch (_) { /* skipped */ }
			}
			stops.forEach(s => { s.removeEventListener('input', stop); s.removeEventListener('change', stop); });
			if (focus && focus[0].isConnected) {
				try { focus[0].focus({ preventScroll: true }); if (focus[1] != null) focus[0].setSelectionRange(focus[1], focus[2]); } catch (_) { }
			}
		};
	}
	function hold(A, el, u) {
		const load = bringLate(u.plugin);
		if (!load) return false;
		const name = u.attr.slice(2);
		heldEls.add(el);
		holding.add(el);
		if (!heldCount++ && window.ManifestPending) heldRelease = window.ManifestPending.hold('held');
		// Once per hold, whatever throws on the way
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			heldEls.delete(el);
			holding.delete(el);
			if (!--heldCount && heldRelease) { const r = heldRelease; heldRelease = null; r(); }
		};
		const early = [];
		let hidden = null;
		try {
			// $refs read during the hold caches its proxy: give the outer root its refs object now
			const root = !el.hasAttribute('x-data') && el.parentElement && el.parentElement.closest('[x-data]');
			if (root) {
				if (!root._x_refs) root._x_refs = {};
				// Its refs inside the held subtree resolve during the hold too (x-ref sets the same entry on start)
				for (const r of [el, ...el.querySelectorAll('[x-ref]')]) {
					const ref = r.getAttribute('x-ref');
					// Last one wins, as when Alpine sets them; a live ref of the same name stays
					if (ref && r.closest('[x-data]') === root && (!root._x_refs[ref] || early.some(e => e[2] === root._x_refs[ref]))) { root._x_refs[ref] = r; early.push([root, ref, r]); }
				}
			}
			hidden = RENDERS.includes(u.plugin) ? el.style.opacity : null;
			if (hidden !== null) el.style.opacity = '0';
		} catch (_) { /* best effort */ }
		const ready = new Promise((resolve) => {
			let started = false;
			whenRegistered(name).then(() => { started = true; resolve(); });
			const giveUp = (why) => {
				if (started) return;
				gaveUp.add(u.plugin);
				if (!warnedLate.has(u.plugin)) { warnedLate.add(u.plugin); console.warn(`[Manifest Loader] ${u.plugin} ${why}: starting the elements that use it now${why === 'failed to load' ? ', without it' : '; it applies to them if it starts later'}.`); }
				resolve();
			};
			load.catch(() => giveUp('failed to load'));
			// Loaded but never registered (e.g. its own vendor file failed): don't hold forever
			load.then(() => setTimeout(() => giveUp('has not started 10 s after loading'), giveUpIn(u.plugin)), () => { });
		});
		const start = ready.then(() => {
			let restore = null;
			try {
				heldEls.delete(el);
				if (hidden !== null) el.style.opacity = hidden;
				// Refs set early for elements removed before start: gone, as if never started
				for (const [root, ref, r] of early) if (!r.isConnected && root._x_refs && root._x_refs[ref] === r) delete root._x_refs[ref];
				restore = snapshot(el);
			} catch (_) { /* start anyway */ }
			// After Alpine's start of the element (same turn), so typed values win over the model's initial one
			setTimeout(() => { try { if (restore) restore(); } finally { release(); } }, 0);
		});
		try { A.deferInit(el, start); } catch (e) { release(); throw e; }
		return true;
	}
	let lateArmed = false;
	function armLateModules() {
		const A = typeof window === 'undefined' ? null : window.Alpine;
		if (lateArmed || !A || !A.directive || !A.magic) return;
		lateArmed = true;
		const directive = A.directive, magic = A.magic;
		A.directive = function (name) {
			const out = directive.apply(this, arguments);
			if (!registered.has(name)) {
				registered.add(name);
				const w = waiters.get(name);
				if (w) { waiters.delete(name); w.resolve(); }
				const els = reset.get(name);
				if (els) {
					reset.delete(name);
					setTimeout(() => els.forEach(([ref, attr]) => { const el = deref(ref); try { if (el && el.isConnected && el.hasAttribute(attr)) el.setAttribute(attr, el.getAttribute(attr)); } catch (_) { } }), 0);
				}
			}
			return out;
		};
		if (typeof A.interceptInit === 'function') {
			const canHold = typeof A.deferInit === 'function';
			// Never breaks Alpine's walk: an element that cannot be held is started as usual
			const intercept = (el) => { try { check(el); } catch (_) { /* not held */ } };
			const check = (el) => {
				if (heldEls.has(el)) return;
				for (const attr of el.attributes) {
					const u = lateDirective(attr.name);
					if (!u || registered.has(u.attr.slice(2))) continue;
					// Given up on: start now, apply the directive if it registers later
					if (gaveUp.has(u.plugin)) { note(u, el, attr.name); continue; }
					if (canHold) { if (hold(A, el, u)) return; continue; }
					// Older Alpine without deferInit: run just that directive once it registers
					if (bringLate(u.plugin)) note(u, el, attr.name);
				}
			};
			A.interceptInit(typeof A.skipDuringClone === 'function' ? A.skipDuringClone(intercept) : intercept);
		}
		armStandIns(A, magic);
	}
	const deref = (r) => r && typeof r.deref === 'function' ? r.deref() : r;
	function note(u, el, attr) {
		const name = u.attr.slice(2);
		if (registered.has(name)) return;
		if (!reset.has(name)) reset.set(name, []);
		// Weakly held: elements removed for good (route swaps) are not kept alive until it registers
		const list = reset.get(name).filter(([ref]) => deref(ref));
		list.push([typeof WeakRef === 'function' ? new WeakRef(el) : el, attr]);
		reset.set(name, list);
	}
	// Forwarding stand-in for a magic whose module has not registered yet
	function armStandIns(A, magic) {
		const real = {};
		const state = A.reactive ? A.reactive({ v: 0 }) : { v: 0 };
		// Probing must not count as a read (a second loader's stand-ins would start loads)
		const has = (name) => { window.__manifestProbing = true; try { return A.evaluate(document.createElement('div'), `typeof $${name}`) !== 'undefined'; } catch (_) { return false; } finally { window.__manifestProbing = false; } };
		// Reads the real value once there; until then reads as empty text, is callable and never thenable
		// methods: only a method call waits (resolving null without the module); `$m(x)` itself stays a stand-in
		const forward = (resolve, settle, methods, prop) => new Proxy(function () { }, {
			get(t, k) {
				const v = resolve();
				if (v != null) { const r = v[k]; return typeof r === 'function' && k !== 'constructor' ? r.bind(v) : r; }
				if (k === Symbol.toPrimitive) return () => '';
				if (typeof k === 'symbol' || k === 'then') return undefined;
				return forward(() => { const b = resolve(); return b == null ? undefined : b[k]; }, settle, methods, true);
			},
			apply(t, self, args) {
				const f = resolve();
				if (typeof f === 'function') return f.apply(self, args);
				// Function-valued magics: the call waits for the module, then runs once
				if (settle && (!methods || prop)) return settle().then(() => { const g = resolve(); return typeof g === 'function' ? g.apply(self, args) : methods ? null : undefined; });
				let done = false, out;
				return forward(() => { if (done) return out; const g = resolve(); if (typeof g !== 'function') return undefined; done = true; return (out = g.apply(self, args)); }, settle, methods, false);
			}
		});
		for (const u of lateEntries) {
			if (!u.magic || preloaded.includes(u.plugin) || pluginsSettled.has(u.plugin)) continue;
			const name = u.magic.slice(1);
			// An app's own magic of the same name stays
			if (has(name)) continue;
			let asked = false;
			const arrived = () => new Promise((resolve) => {
				if (real[name]) return resolve();
				const load = bringLate(u.plugin);
				if (!load) return resolve();
				const check = () => real[name] ? resolve() : null;
				load.then(() => setTimeout(() => { check(); setTimeout(resolve, 0); }, 0), resolve);
			});
			magic.call(A, name, (el, utils) => {
				void state.v;
				if (real[name]) return real[name](el, utils);
				if (!asked && !window.__manifestProbing) {
					asked = true;
					// No markup trigger (e.g. a script file): load it now, or say why it never will
					if (!bringLate(u.plugin) && !warnedLate.has(name) && !warnedLate.has(u.plugin)) {
						warnedLate.add(name);
						const fix = _omitted.includes(u.plugin) ? `remove ${u.plugin} from data-omit` : `add data-modules="+${u.plugin}"`;
						console.warn(`[Manifest Loader] ${u.magic} is used but ${u.plugin} is not loaded on this page: ${fix}.`);
					}
				}
				// A file picker needs the click's user activation, which may expire while the module loads
				const fn = !u.call && !u.methods ? null : u.magic !== '$import' ? arrived : () => arrived().then(() => {
					const ua = navigator.userActivation;
					if (ua && !ua.isActive && !warnedLate.has('$import:activation')) {
						warnedLate.add('$import:activation');
						console.warn('[Manifest Loader] $import waited for its module and the click that called it expired, so the browser may not open the file picker. Add data-modules="+import" to load it with the page.');
					}
				});
				return forward(() => real[name] ? real[name](el, utils) : undefined, fn, !!u.methods);
			});
		}
		A.magic = function (name, cb) {
			if (lateEntries.some(u => u.magic === '$' + name)) { real[name] = cb; setTimeout(() => { state.v++; }, 0); }
			return magic.apply(this, arguments);
		};
	}
	if (typeof document !== 'undefined') {
		document.addEventListener('alpine:init', armLateModules, { once: true });
		if (typeof window !== 'undefined' && window.Alpine && window.Alpine.magic) armLateModules();
	}
	// Inside a held subtree: modules that walk elements themselves leave these to the hold
	if (typeof window !== 'undefined') window.__manifestHeld = (el) => { if (!heldCount) return false; for (let n = el; n; n = n.parentElement) if (heldEls.has(n)) return true; return false; };
	// Framework web components — <x-*> tags that are NOT project components.
	const FRAMEWORK_TAG_RE = /^x-(code|code-group)$/;
	// Attribute values seen to hold no usage magic at all; repeated rows hit this instead of the regexes
	const USAGE_ANY_RE = new RegExp('\\$(' + USAGE_PLUGINS.filter(u => u.magic).map(u => u.magic.slice(1)).join('|') + ')\\b');
	const usageClean = new Set();
	function detectUsagePlugins(alreadyLoaded, root = typeof document === 'undefined' ? null : document) {
		const wanted = USAGE_PLUGINS.filter(u => !alreadyLoaded.includes(u.plugin));
		// <x-*> tags load the components plugin even with nothing registered in
		// manifest.json (the loader's components/<name>.html convention).
		const wantComponents = !alreadyLoaded.includes('components');
		if ((wanted.length === 0 && !wantComponents) || !root) return [];
		const found = new Set();
		const open = new Set(wanted.map(u => u.plugin));
		const target = open.size + (wantComponents ? 1 : 0);
		const done = () => found.size === target;
		const take = (p) => { if (p && open.has(p) && !found.has(p)) found.add(p); };
		const wantCode = open.has('code');

		for (const s of root.querySelectorAll('script:not([src])')) {
			const t = s.textContent || '';
			for (const u of wanted) if (u.re && !found.has(u.plugin) && u.re.test(t)) found.add(u.plugin);
			if (done()) return [...found];
		}

		const check = (el) => {
			if (wantComponents && !found.has('components')) {
				const tag = el.tagName.toLowerCase();
				if (tag.startsWith('x-') && !FRAMEWORK_TAG_RE.test(tag)) found.add('components');
			}
			if (wantCode) take(elementPlugin(el));
			for (const attr of el.attributes || []) {
				take(attrPlugin(attr.name));
				const v = attr.value;
				if (!v || v.indexOf('$') === -1 || usageClean.has(v)) continue;
				if (!USAGE_ANY_RE.test(v)) {
					if (usageClean.size > 20000) usageClean.clear();
					usageClean.add(v);
					continue;
				}
				for (const u of wanted) if (u.re && !found.has(u.plugin) && u.re.test(v)) found.add(u.plugin);
			}
		};
		const scan = (node) => {
			for (const el of node.querySelectorAll('*')) {
				check(el);
				if (done()) return;
				if (el.tagName === 'TEMPLATE' && el.content) {
					scan(el.content);
					if (done()) return;
				}
			}
		};
		if (root.nodeType === 1) {
			check(root);
			if (root.tagName === 'TEMPLATE' && root.content) scan(root.content);
		}
		if (!done()) scan(root);
		return [...found];
	}

	// Boot sniff, once per page: everything the parsed document uses (nothing counted as loaded);
	// nodes added before the loader applies it are scanned then, not the whole document again
	let bootUsage = null;
	function sniffBoot() {
		if (bootUsage) return bootUsage;
		const added = new Set();
		const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
			for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) added.add(n);
		});
		if (mo) mo.observe(document.documentElement, { childList: true, subtree: true });
		const used = detectUsagePlugins([]);
		bootUsage = {
			used,
			take() {
				if (mo) mo.disconnect();
				const all = new Set(used);
				for (const n of added) if (n.isConnected) detectUsagePlugins([...all], n).forEach(p => all.add(p));
				added.clear();
				return [...all];
			}
		};
		return bootUsage;
	}

	// Post-boot usage: component HTML, x-html and markdown content load the
	// on-use plugins they reference. Derive path only, like the boot sniff.
	let usageSniff = false;
	// Derive path: loadUsed works once the loader has queued its own modules; earlier calls wait for that
	let usageArmed = false;
	let usageGate = null;
	// A failed on-use load is not retried within this page load
	const usageFailed = new Set();
	// Settled loads only: a second caller waits on a load still in flight
	const usageLoaded = (p) => pluginsSettled.has(p) || usageFailed.has(p);
	function loadUsed(source, version = RESOLVED_VERSION) {
		if (!usageArmed) return usageGate && source ? usageGate.promise.then(() => usageArmed ? loadUsed(source, version) : []) : Promise.resolve([]);
		if (!source || typeof document === 'undefined') return Promise.resolve([]);
		let root = source;
		if (typeof source === 'string') {
			if (source.indexOf('x-') === -1 && source.indexOf('$') === -1 && source.indexOf('<code') === -1) return Promise.resolve([]);
			root = document.createElement('template');
			root.innerHTML = source;
			root = root.content;
		}
		const loaded = USAGE_NAMES.filter(usageLoaded).concat('components', _omitted);
		const used = detectUsagePlugins(loaded, root);
		if (!used.length) return Promise.resolve([]);
		return fetchUsed(resolveDependencies(used).filter(p => !usageLoaded(p)), version);
	}
	function fetchUsed(list, version = RESOLVED_VERSION) {
		if (!list.length) return Promise.resolve([]);
		// Prerender waits for the module and the adoption it schedules
		const release = window.ManifestPending ? window.ManifestPending.hold('module') : () => { };
		// On-use modules run as they arrive: nothing (Alpine included) queues behind them
		const ready = Promise.all(list.map(p => addScript(p, version, !lateEntries.some(u => u.plugin === p)).catch(error => {
			if (usageFailed.has(p)) return;
			usageFailed.add(p);
			console.warn(`[Manifest Loader] Failed to load plugin ${p}:`, error);
		}))).then(() => Promise.all(list.map(started))).then(() => new Promise(r => setTimeout(r, 0)));
		ready.then(release);
		// Content waits at most 1.5 s: a slower module is left to the hold
		return Promise.race([ready, new Promise(r => setTimeout(r, USED_WAIT))]).then(() => list);
	}
	const USED_WAIT = 1500;
	// Its directive registered (Markdown waits for its parser first), at most 1.5 s after the file ran
	function started(p) {
		const u = lateEntries.find(e => e.plugin === p && e.attr);
		if (!u || !window[u.present] || usageFailed.has(p) || gaveUp.has(p) || preloaded.includes(p) || registered.has(u.attr.slice(2))) return null;
		return Promise.race([whenRegistered(u.attr.slice(2)), new Promise(r => setTimeout(r, Math.max(0, USED_WAIT - sinceRan(p))))]);
	}

	function watchUsage(version) {
		if (typeof MutationObserver === 'undefined') return;
		const pending = new Set();
		let queued = false;
		const allLoaded = () => USAGE_PLUGINS.every(u => usageLoaded(u.plugin) || _omitted.includes(u.plugin));
		const observer = new MutationObserver((records) => {
			for (const r of records) {
				if (r.type === 'attributes') { attrAdded(r.target, r.attributeName); continue; }
				for (const n of r.addedNodes) if (n.nodeType === 1) pending.add(n);
			}
			if (queued || !pending.size) return;
			queued = true;
			setTimeout(() => {
				queued = false;
				const nodes = [...pending].filter(n => n.isConnected);
				pending.clear();
				nodes.forEach(n => loadUsed(n, version));
				if (allLoaded()) observer.disconnect();
			}, 0);
		});
		// Attribute additions on live elements, on-use directive names only (exact: setAttribute('x-date', …))
		observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: LATE_ATTRS });
	}
	function attrAdded(el, name) {
		const u = lateDirective(name);
		if (!u || !el.hasAttribute(name) || registered.has(u.attr.slice(2)) || window.__manifestHeld(el)) return;
		if (bringLate(u.plugin)) note(u, el, name);
	}

	const RENAMED_PLUGINS = { 'text-edit': 'rich-text' };
	function dropRenamed(list) {
		return list.filter(p => {
			const name = p.replace(/^\+/, '');
			if (!RENAMED_PLUGINS[name]) return true;
			console.warn(`[Manifest Loader] ${name} was renamed to ${RENAMED_PLUGINS[name]}`);
			return false;
		});
	}

	// Detect the device plugin (, , , …). Auto-loaded inside a
	// Capacitor container, or when a `device` (formerly `native`) block opts in on the web.
	function detectNativePlugins(manifest) {
		if (typeof window !== 'undefined' && window.Capacitor) return ['device'];
		const block = manifest && typeof manifest === 'object' ? (manifest.device ?? manifest.native) : null;
		if (block && typeof block === 'object') return ['device'];
		return [];
	}

	// Parse data attributes
	function parseDataAttributes() {
		// Try to get current script first, then fall back to querySelector
		let script = document.currentScript;
		if (!script) {
			// Look for manifest.js script tag
			script = document.querySelector('script[src*="manifest.js"]');
		}
		if (!script) {
			return null;
		}

		// `data-modules` is canonical; `data-plugins` is the legacy alias.
		const plugins = script.getAttribute('data-modules') ?? script.getAttribute('data-plugins');
		const omit = script.getAttribute('data-omit');
		const tailwind = script.getAttribute('data-tailwind') !== null;
		// data-tailwind="cache": opt in to replaying the engine's stored output
		const tailwindCache = script.getAttribute('data-tailwind') === 'cache';
		const version = script.getAttribute('data-version') || DEFAULT_VERSION;
		const versionSet = !!script.getAttribute('data-version');
		const alpine = script.getAttribute('data-alpine');
		// integrity= on the loader turns checks on; data-integrity (boolean) opts in without it,
		// "warn" logs instead of refusing, "off"/"false" opts out
		const integrityAttr = (script.getAttribute('data-integrity') ?? '').trim().toLowerCase();
		const integrity = /^(off|false)$/.test(integrityAttr) ? null
			: integrityAttr === 'warn' ? 'warn'
			: script.hasAttribute('data-integrity') || !!script.getAttribute('integrity') ? 'strict' : null;
		// Override: resolve plugin URLs against this base (dir serving
		// `manifest.<name>.js`, relative or absolute) instead of the CDN.
		const pluginBase = script.getAttribute('data-module-base') ?? script.getAttribute('data-plugin-base');
		// Override: custom CDN fallback chain (comma-separated origins).
		const cdn = script.getAttribute('data-cdn');
		// App-shell service worker switch: 'off' = never, 'on' = force + debug log.
		const sw = script.getAttribute('data-sw');

		// `data-modules="a,b"` replaces the default set; a `+` prefix is additive
		// (`data-modules="+chat"` = defaults plus chat) — needed for modules with
		// no manifest.json trigger, e.g. chat driven by custom adapters only.
		let pluginList = [];
		let extraPlugins = [];
		let deriveFromManifest = !plugins;

		if (plugins) {
			const entries = dropRenamed(plugins.split(',').map(p => p.trim()).filter(p => p));
			extraPlugins = entries.filter(p => p.startsWith('+')).map(p => p.slice(1));
			const explicit = entries.filter(p => !p.startsWith('+'));
			if (explicit.length > 0) {
				pluginList = [...explicit, ...extraPlugins];
			} else {
				// Only additive entries: keep the default derive-from-manifest
				// behavior and append the extras once the manifest is inspected.
				deriveFromManifest = true;
				pluginList = AVAILABLE_PLUGINS.slice();
			}
		} else {
			// Default: start with all core plugins; loader will trim by manifest when manifest is available
			pluginList = AVAILABLE_PLUGINS.slice();
		}

		// Remove omitted plugins (supports both core and Appwrite plugins)
		const OMIT_ALIASES = { native: 'device', 'text-edit': 'rich-text' };
		const omitted = omit ? omit.split(',').map(p => p.trim().toLowerCase()).map(p => OMIT_ALIASES[p] || p).filter(p => p && !ALWAYS_ON.includes(p)) : [];
		if (omitted.length > 0 && pluginList.length > 0) {
			pluginList = pluginList.filter(p => !omitted.includes(p));
		}

		// Resolve dependencies (auto-inject required plugins)
		pluginList = resolveDependencies(pluginList);

		return {
			plugins: pluginList,
			extraPlugins,
			omitted,
			deriveFromManifest,
			tailwind,
			tailwindCache,
			version,
			versionSet,
			alpine,
			alpineIntegrity: script.getAttribute('data-alpine-integrity'),
			integrity,
			pluginBase,
			cdn,
			sw,
		};
	}

	// A publish/render bake stamps `data-mnfst-utilities-complete` on its
	// `<style data-mnfst-utilities>` sheet once it has verified every class
	// scanned from the page's own HTML got a rule (Manifest's + the baked
	// Tailwind pass — see compileUtilities in manifest.utilities.node.mjs).
	// Only the inline `<style>` case is checked: it's synchronous, so this can
	// run before deciding whether to fetch the Tailwind engine at all — a
	// `<link>` sheet would need an async load first, so it's left alone
	// (fail open: Tailwind still loads). No flag, no attribute, any read
	// error → false, so this never skips loading the engine speculatively.
	function staticUtilitiesFullyCovered() {
		try {
			const el = document.querySelector('style[data-mnfst-utilities][data-mnfst-utilities-complete]');
			return !!el;
		} catch (e) {
			return false;
		}
	}

	// Tailwind engine output cache: written and watched by the utilities module (manifest.utilities.tailwind-cache.js)
	const TAILWIND_ENGINE_VERSION = '';
	const TAILWIND_CACHE_KEY = 'tailwind-engine-cache:v2';
	const TAILWIND_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
	function tailwindAuthorBlocks() {
		return Array.from(document.querySelectorAll('style[type="text/tailwindcss"]:not(#manifest-tailwind-variants)'), s => s.textContent);
	}
	// One entry per ordered set of author blocks
	function tailwindCacheId(v, blocks) {
		const text = [v, ...blocks].join('\u0000');
		let h = 0x811c9dc5;
		for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
		return (h >>> 0).toString(36);
	}
	function placeTailwindCache(style) {
		const ours = document.getElementById('manifest-styles');
		document.head.insertBefore(style, ours && ours.parentNode === document.head ? ours : null);
	}
	const allStrings = (a) => Array.isArray(a) && a.every(x => typeof x === 'string');
	// Head fully parsed: replay only an entry built from exactly these blocks, in this order
	function tryTailwindReplay(state, index) {
		try {
			// A page that turned out to need a block in <body> goes straight to the engine
			const skipped = index.skip && index.skip[state.pathId];
			if (typeof skipped === 'number' && Date.now() - skipped >= 0 && Date.now() - skipped <= TAILWIND_CACHE_MAX_AGE) return false;
			const blocks = tailwindAuthorBlocks();
			const id = tailwindCacheId(state.v, blocks);
			const rec = JSON.parse(localStorage.getItem(`${TAILWIND_CACHE_KEY}:${id}`) || 'null');
			const age = rec ? Date.now() - rec.t : -1;
			if (!rec || rec.v !== state.v || typeof rec.css !== 'string' || !allStrings(rec.tokens) || !allStrings(rec.blocks)) return false;
			if (!(age >= 0 && age <= TAILWIND_CACHE_MAX_AGE) || rec.blocks.join('\u0000') !== blocks.join('\u0000') || rec.blocks.length !== blocks.length) return false;
			if (rec.body) return false;
			const style = document.createElement('style');
			style.setAttribute('data-tailwind-cache', '');
			style.textContent = rec.css;
			placeTailwindCache(style);
			Object.assign(state, { record: rec, style, id });
			return true;
		} catch (e) {
			return false;
		}
	}
	// Resolves true once the stored output is where the engine's sheet would go; decided when <head> is parsed, before first paint.
	// A <body> block, or a pathname skipped in the last 7 days, means the engine (SPA routes keep the first pathname's decision)
	function replayTailwindCache(cfg) {
		const miss = Promise.resolve(false);
		try {
			if (!cfg.tailwindCache || window.__manifestRender === true || window.__mnfstRun || isDevHost(location.hostname)) return miss;
			if (!cfg.plugins.includes('utilities') || staticUtilitiesFullyCovered()) return miss;
			if (document.querySelector('[data-mnfst-utilities], link[href*="prerender.tailwind.css"], link[href*="prerender.utilities.css"]')) return miss;
			const v = `${LOADER_VERSION}|${cfg.version}|${TAILWIND_ENGINE_VERSION}`;
			const state = window.__tailwindCache = { key: TAILWIND_CACHE_KEY, v, idFor: (blocks) => tailwindCacheId(v, blocks), pathId: tailwindCacheId('', [location.pathname]), record: null, armed: false };
			const index = JSON.parse(localStorage.getItem(TAILWIND_CACHE_KEY) || 'null');
			if (!index || !allStrings(index.ids) || !index.ids.length) return miss;
			return state.decision = new Promise(resolve => {
				let done = false;
				const decide = () => {
					if (done) return;
					done = true;
					const hit = tryTailwindReplay(state, index);
					if (hit) watchParsedTailwindBlocks(state, cfg.version);
					resolve(hit);
				};
				if (document.body) return decide();
				const o = new MutationObserver(() => { if (document.body) { o.disconnect(); decide(); } });
				o.observe(document.documentElement, { childList: true });
				document.addEventListener('DOMContentLoaded', () => { o.disconnect(); decide(); }, { once: true });
			});
		} catch (e) {
			return miss;
		}
	}
	// Until DOMContentLoaded: a parsed block the entry wasn't built from means it is another page's theme; engine now
	function watchParsedTailwindBlocks(state, version) {
		const o = new MutationObserver((records) => {
			for (const r of records) {
				for (const n of r.addedNodes) {
					if (n.localName !== 'style' || n.getAttribute('type') !== 'text/tailwindcss' || n.id === 'manifest-tailwind-variants') continue;
					const blocks = tailwindAuthorBlocks();
					if (blocks.length <= state.record.blocks.length && blocks.every((b, i) => b === state.record.blocks[i])) continue;
					o.disconnect();
					if (state.style) state.style.remove();
					Object.assign(state, { style: null, parsedMismatch: true });
					state.load = loadTailwind(version).catch(() => { });
					return;
				}
			}
		});
		o.observe(document.documentElement, { childList: true, subtree: true });
		document.addEventListener('DOMContentLoaded', () => o.disconnect(), { once: true });
	}

	// Where the eager engine would have landed (after the module wave), or the engine itself if nothing armed
	function settleTailwindCache(version) {
		const state = window.__tailwindCache;
		if (!state || !state.style || !state.style.isConnected) return;
		if (!state.armed) {
			state.load = loadTailwind(version).catch(() => { });
			return;
		}
		let next = state.style.nextElementSibling;
		const isCss = (el) => (el.localName === 'style' && el.id !== 'manifest-styles' && el.getAttribute('type') !== 'text/tailwindcss') || (el.localName === 'link' && /\bstylesheet\b/i.test(el.rel));
		while (next && !isCss(next)) next = next.nextElementSibling;
		if (next) placeTailwindCache(state.style);
	}

	// Load custom Tailwind CDN script, falling through the CDN chain on error
	async function loadTailwind(version = RESOLVED_VERSION) {
		const urls = CDN_HOSTS.map(h => `${getBaseUrl(version, h)}/${hostFile(h, 'manifest.tailwind.min.js')}`);
		let lastErr = null;
		try {
			return await injectFrom(urls);
		} catch (e) {
			lastErr = e;
		}
		console.warn(`[Manifest Loader] Tailwind plugin not available from any CDN. Load it directly: <script src="/scripts/tailwind.v4.3.1.js"></script>`);
		throw lastErr || new Error(`Tailwind plugin not available from CDN.`);
	}

	// Expose API
	window.Manifest = {
		loadPlugin: function (pluginName, version = RESOLVED_VERSION) {
			// 'tailwind' isn't a core/Appwrite/authoring plugin — it's the Play-CDN
			// browser engine (lib/manifest.tailwind.js) — but the utilities plugin's
			// uncovered-class watcher lazily loads it this way (see
			// manifest.utilities.static.js setupUncoveredClassWatcher).
			const allPlugins = [...AVAILABLE_PLUGINS, ...USAGE_LOADED_PLUGINS, ...APPWRITE_PLUGINS, ...AUTHORING_PLUGINS, 'payments', 'chat', 'device', 'native', 'import', 'tailwind'];
			if (!allPlugins.includes(pluginName)) {
				if (RENAMED_PLUGINS[pluginName]) dropRenamed([pluginName]);
				else console.warn(`[Manifest Loader] Unknown module: ${pluginName}`);
				return Promise.reject(new Error(`Unknown module: ${pluginName}`));
			}

			// Resolve dependencies for single plugin load
			const pluginList = resolveDependencies([pluginName]);

			// Load plugin and its dependencies
			return Promise.all(pluginList.map(plugin => addScript(plugin, version)));
		},
		loadTailwind: loadTailwind,
		loadVendor: loadVendor,
		fetchVendor: fetchVendor,
		// True while every script the loader adds is checked against published hashes
		get integrity() { return integrityActive; },
		getPluginUrl: getPluginUrl,
		getModuleUrl: getPluginUrl,
		// On-use plugins referenced by an HTML string or element
		loadUsed: loadUsed
	};

	window.Manifest.loadModule = window.Manifest.loadPlugin;

	// ---- App-shell service worker (PERF-PRIMITIVES-DESIGN §13) ----
	// Same-origin `/sw.js` stub — two lines, identical wherever it is emitted
	// (managed hosting, mnfst-publish, the starter template, by hand):
	//   try { importScripts('https://cdn.manifestx.dev/npm/mnfst@<v>/lib/manifest.sw.min.js'); } catch (e) { importScripts('https://cdn.jsdelivr.net/npm/mnfst@<v>/lib/manifest.sw.min.js'); }
	//   if (!self.__mnfstSw) self.addEventListener('activate', function () { self.registration.unregister(); });
	// Line 1 pins the worker module to the framework version (CDN fallback; a
	// second failure fails install, so the previous worker survives). Line 2
	// unregisters a worker whose module never loaded.
	const SW_STUB_PATH = '/sw.js';
	function swStub(version = DEFAULT_VERSION) {
		const v = String(version || DEFAULT_VERSION).replace(/[^\w.+-]/g, '');
		const file = `mnfst@${v}/lib/manifest.sw.min.js`;
		return `try { importScripts('https://cdn.manifestx.dev/npm/${file}'); } catch (e) { importScripts('https://cdn.jsdelivr.net/npm/${file}'); }\n` +
			`if (!self.__mnfstSw) self.addEventListener('activate', function () { self.registration.unregister(); });\n`;
	}

	const swState = { registered: false, version: null, kill: () => swKill(null) };
	window.Manifest.swStub = swStub;
	window.Manifest.sw = swState;

	function importsCrossOrigin(src) {
		const calls = String(src).match(/importScripts\s*\(([^)]*)\)/g) || [];
		return calls.some(c => (c.match(/https?:\/\/[^'"`\s)]+/g) || []).some(u => {
			try { return new URL(u).origin !== location.origin; } catch (_) { return true; }
		}));
	}

	function isDevHost(host) {
		const h = String(host || '').toLowerCase();
		return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h === '0.0.0.0' ||
			h.endsWith('.localhost') || h.endsWith('.local');
	}

	// Kill switch: tell the worker to clear its caches, unregister, and sweep
	// any cache left behind. Never throws.
	async function swKill(registration) {
		swState.registered = false;
		try {
			const reg = registration || await navigator.serviceWorker.getRegistration(SW_STUB_PATH);
			if (reg) {
				const worker = reg.active || reg.waiting || reg.installing;
				try { if (worker) worker.postMessage({ type: 'manifest:sw', action: 'kill' }); } catch (_) { /* gone */ }
				await reg.unregister();
			}
		} catch (_) { /* nothing to kill */ }
		try {
			if (window.caches) {
				const names = await caches.keys();
				await Promise.all(names.filter(n => n.startsWith('mnfst-sw:')).map(n => caches.delete(n)));
			}
		} catch (_) { /* no cache access */ }
	}

	// Turnkey inference (§13.2): runs once the page has settled, never during
	// boot. Every exit is silent unless data-sw="on" (debug + force on localhost).
	async function swInfer(cfg) {
		const mode = cfg.sw;
		const debug = mode === 'on';
		const log = debug ? (...a) => console.info('[Manifest SW]', ...a) : () => { };
		if (!navigator.serviceWorker) return log('skip: unsupported');
		const loc = window.location;
		const devServer = !!window.__mnfstRun;
		const devOrigin = isDevHost(loc.hostname);
		let manifest = window.__manifestLoaded || null;
		if (!manifest && window.__manifestPromise) manifest = await window.__manifestPromise.catch(() => null);
		if (!manifest) {
			const url = document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '/manifest.json';
			manifest = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
		}
		const off = mode === 'off' || (manifest && manifest.sw === false);
		const existing = await navigator.serviceWorker.getRegistration(SW_STUB_PATH).catch(() => null);
		if (off || devServer || (devOrigin && !debug)) {
			log('skip:', off ? 'kill switch' : devServer ? 'mnfst-run' : 'dev origin', existing ? '(unregistering)' : '');
			await swKill(existing); // also sweeps caches a killed worker's in-flight fetches left behind
			return;
		}
		if (loc.protocol !== 'https:' && !(debug && window.isSecureContext)) return log('skip: not https');
		// Stub probe: no stub → nothing happens, no console noise.
		let probe = null;
		try { probe = sessionStorage.getItem('manifest:sw-probe'); } catch (_) { /* no storage */ }
		const strict = integrityMode === 'strict';
		if (probe !== 'ok' || strict) {
			const res = await fetch(SW_STUB_PATH, { cache: 'no-store' }).catch(() => null);
			const type = (res && res.headers.get('content-type')) || '';
			if (!res || !res.ok || !/javascript|ecmascript/i.test(type)) return log('skip: no stub', res && res.status, type);
			// importScripts can't carry a hash: with checks on, only a worker served from this origin registers
			if (strict && importsCrossOrigin(await res.text().catch(() => ''))) {
				console.warn(`[Manifest Loader] ${SW_STUB_PATH} imports its worker module from another origin, which integrity checks can't cover, so the service worker stays off. Serve the module from this origin (copy lib/manifest.sw.min.js into ${SW_STUB_PATH}), set data-sw="off", or set data-integrity="warn" to register it anyway.`);
				await swKill(existing);
				return;
			}
			try { sessionStorage.setItem('manifest:sw-probe', 'ok'); } catch (_) { /* no storage */ }
		}
		const deployment = (manifest && typeof manifest.deployment === 'string') ? manifest.deployment : '';
		const url = `${SW_STUB_PATH}?v=${encodeURIComponent(cfg.version)}&d=${encodeURIComponent(deployment)}`;
		const reg = await navigator.serviceWorker.register(url, { scope: '/' });
		swState.registered = true;
		swState.version = cfg.version;
		log('registered', url, reg.active ? 'active' : reg.installing ? 'installing' : 'waiting');
	}

	function armServiceWorker(cfg) {
		if (!cfg || window.__manifestSwArmed) return;
		const token = window.__manifestSwArmed = {};
		let ran = false;
		const run = () => {
			if (ran || window.__manifestSwArmed !== token) return;
			ran = true;
			try { swInfer(cfg).catch(() => { }); } catch (_) { /* never throws */ }
		};
		// After manifest:ready when this loader boots the page; a loader that
		// loads nothing (self-hosted scripts) settles on window load instead.
		const settle = () => {
			if (window.__manifestReady) return run();
			window.addEventListener('manifest:ready', run, { once: true });
			if (!window.__manifestLoaderStarted) {
				if (document.readyState === 'complete') setTimeout(run, 0);
				else window.addEventListener('load', run, { once: true });
			}
		};
		setTimeout(settle, 0); // after this script finishes, so __manifestLoaderStarted is settled
	}

	// mnfst:route.match:start — synced by the build from scripts/snippets/manifest.route.match.js; edit there
// x-route matching, shared by the router and the loader's parse-time pass

// Logical route path for a pathname under an app base path ('' at the root)
function routeLogicalPath(pathname, base) {
    if (!base) {
        const p = (pathname || '/').replace(/\/$/, '') || '/';
        if (p === '/' || p === '/index.html' || p === '/index') return '/';
        return p.startsWith('/') ? p : '/' + p;
    }
    if (pathname === base || pathname === base + '/') return '/';
    if (pathname.startsWith(base + '/')) {
        let logical = pathname.slice(base.length) || '/';
        if (logical === '/index.html' || logical === '/index') logical = '/';
        return logical;
    }
    if (pathname === base + '/index.html' || pathname === base + '/index') return '/';
    return pathname;
}

// One condition against a path; a leading locale code in the path is ignored
function routePathMatches(path, condition, localizationCodes) {
    const normalizedPath = path === '/' ? '/' : path.replace(/^\/+|\/+$/g, '') || '/';

    let pathToCheck = normalizedPath;
    if (localizationCodes.length > 0) {
        const pathSegments = normalizedPath.split('/').filter(segment => segment);
        if (pathSegments.length > 0 && localizationCodes.includes(pathSegments[0])) {
            pathToCheck = pathSegments.slice(1).join('/') || '/';
        }
    }

    // Wildcards
    if (condition.includes('*')) {
        if (condition === '*') return true;
        const wildcardPattern = condition.replace('*', '');
        const normalizedPattern = wildcardPattern.replace(/^\/+|\/+$/g, '');
        return pathToCheck.startsWith(normalizedPattern + '/');
    }

    // Exact (=)
    if (condition.startsWith('=')) {
        const exactPath = condition.slice(1);
        if (exactPath === '/') {
            return pathToCheck === '/' || pathToCheck === '';
        }
        const normalizedExactPath = exactPath.replace(/^\/+|\/+$/g, '');
        return pathToCheck === normalizedExactPath;
    }

    // Path and subpaths (/)
    if (condition.startsWith('/')) {
        if (condition === '/') {
            return pathToCheck === '/' || pathToCheck === '';
        }
        const routePath = condition.replace(/^\//, '');
        return pathToCheck === routePath || pathToCheck.startsWith(routePath + '/');
    }

    // Substring
    return pathToCheck.includes(condition);
}

// A comma list of conditions ('!' negates); null when the list has '!*', which needs every defined route
function routeConditionsMatch(routeCondition, normalizedPath, matches) {
    const conditions = routeCondition.split(',').map(cond => cond.trim());
    if (conditions.includes('!*')) return null;
    const positiveConditions = conditions.filter(cond => !cond.startsWith('!'));
    const negativeConditions = conditions
        .filter(cond => cond.startsWith('!'))
        .map(cond => cond.slice(1));
    const hasNegativeMatch = negativeConditions.some(cond => matches(normalizedPath, cond));
    const hasPositiveMatch = positiveConditions.length === 0 || positiveConditions.some(cond => matches(normalizedPath, cond));
    return hasPositiveMatch && !hasNegativeMatch;
}
// mnfst:route.match:end

	// Path the router will match, while parsing; null when a base path or prerender leaves it uncertain
	function parsePagePath() {
		if (document.querySelector('meta[name="manifest:prerendered"][content="1"], meta[name="manifest:router-base-depth"]')) return null;
		const base = document.querySelector('meta[name="manifest:router-base"]')?.getAttribute('content');
		if (base && base.replace(/^\/+|\/+$/g, '').trim()) return null;
		try {
			const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '/manifest.json';
			if (new URL(href, location.href).pathname.replace(/\/[^/]*$/, '') !== '') return null;
		} catch (_) { return null; }
		const logical = routeLogicalPath(location.pathname, '');
		return logical === '/' ? '/' : logical.replace(/^\/|\/$/g, '');
	}

	// Surely off-route: no reading of a leading locale segment (code or not) matches; '!*' waits for the router
	function routeSurelyHidden(condition, path) {
		if (condition.split(',').some(cond => cond.trim() === '!*')) return true;
		const first = path.split('/').filter(Boolean)[0];
		const readings = first && /^[a-z]{2}(-[A-Z]{2})?$/.test(first) ? [[], [first]] : [[]];
		return readings.every(codes => routeConditionsMatch(condition, path, (p, c) => routePathMatches(p, c, codes)) === false);
	}

	// Panels hidden at parse until the tabs module converts them; shown again if it never loads
	const parseHiddenPanels = [];
	function revealParseHiddenPanels() {
		if (window.ensureTabsPluginInitialized) return;
		for (const el of parseHiddenPanels.splice(0)) if (el.__manifestTabHidden && el.style.display === 'none' && !el.hasAttribute('x-show')) el.style.removeProperty('display');
	}

	// As the parser adds them, hide what Alpine or a module will hide, so nothing paints before it does:
	// x-show and :hidden elements and tab panels other than each group's default (cloak, or display for panels),
	// and with the router, routes that surely don't match and x-show routes; the matching route paints
	function cloakWhileParsing({ routes, tabs }) {
		if (document.readyState !== 'loading' || typeof MutationObserver === 'undefined' || window.__manifestRender === true) return;
		let path;
		const tabGroups = new Map();
		const seen = new WeakSet();
		const alpineHides = (el) => {
			for (const attr of el.attributes) {
				const n = attr.name;
				if (n === 'x-show' || n.startsWith('x-show.') || n === ':hidden' || n === 'x-bind:hidden') return true;
			}
			return false;
		};
		// The tabs module shows the panels matching each group's first panel (id, else first class) unless an x-data sets the group's tab
		const inactivePanel = (el) => {
			const ident = el.id || (el.className ? el.className.split(' ')[0] : '');
			if (!ident) return false;
			const group = el.getAttribute('x-tabpanel') || '';
			if (!tabGroups.has(group)) {
				const prop = group ? 'tab_' + group.replace(/[^a-zA-Z0-9_$]/g, '_') : 'tab';
				const set = new RegExp('(^|[{,\\s])' + prop.replace(/\$/g, '\\$') + '\\s*:');
				let authored = false;
				for (let scope = el.closest('[x-data]'); scope && !authored; scope = scope.parentElement?.closest('[x-data]')) authored = set.test(scope.getAttribute('x-data'));
				tabGroups.set(group, authored ? null : ident);
			}
			return tabGroups.get(group) !== ident;
		};
		const visit = (el) => {
			const condition = routes && path !== null ? el.getAttribute('x-route') : null;
			const panel = tabs && el.hasAttribute('x-tabpanel');
			const hides = alpineHides(el);
			if (condition === null && !panel && !hides) return;
			if (seen.has(el)) return;
			seen.add(el);
			if (el.hasAttribute('x-cloak') || el.closest('[x-ignore]')) return;
			if (condition && routeSurelyHidden(condition, path)) {
				el.setAttribute('x-cloak', '');
				el.__manifestRouteCloak = true;
				return;
			}
			if (panel) {
				if (inactivePanel(el) && !el.style.display) {
					el.style.display = 'none';
					el.__manifestTabHidden = true;
					parseHiddenPanels.push(el);
				}
				return;
			}
			if (hides && el.closest('[x-data]')) {
				el.setAttribute('x-cloak', '');
				if (condition !== null) el.__manifestRouteCloak = true;
			}
		};
		const observer = new MutationObserver((records) => {
			if (path === undefined && document.body) {
				if (document.querySelector('meta[name="manifest:prerendered"][content="1"]')) return observer.disconnect();
				path = routes ? parsePagePath() : null;
			}
			if (path === undefined) return;
			for (const record of records) {
				for (const node of record.addedNodes) if (node.nodeType === 1) visit(node);
			}
		});
		observer.observe(document.documentElement, { childList: true, subtree: true });
		// Parser-added elements each arrive alone; a sweep at the end catches markup a script inserted whole
		document.addEventListener('DOMContentLoaded', () => {
			observer.disconnect();
			if (path !== undefined) document.querySelectorAll('[x-route], [x-show], [x-tabpanel], [\\:hidden], [x-bind\\:hidden]').forEach(visit);
		}, { once: true });
	}

	// Parse config and load plugins
	const config = parseDataAttributes();
	if (config && config.version) RESOLVED_VERSION = config.version;
	if (config && config.pluginBase) setPluginBase(config.pluginBase);
	if (config && config.omitted) _omitted = config.omitted;
	if (config && config.cdn) setCdnHosts(config.cdn);
	if (config && config.integrity) {
		integrityMode = config.integrity;
		// Modules follow the loader's own version unless data-version says otherwise
		if (!config.versionSet && MODULES_INTEGRITY) RESOLVED_VERSION = config.version = LOADER_VERSION;
		integrityActive = !!MODULES_INTEGRITY && config.version === LOADER_VERSION;
		alpineIntegrity = config.alpineIntegrity && SRI_VALUE.test(config.alpineIntegrity.trim()) ? config.alpineIntegrity.trim() : null;
		integrityReady = loadIntegrity(config);
		integrityReady.catch(() => { });
	}
	armServiceWorker(config);

	if (config && config.plugins.length > 0) {
		if (window.__manifestLoaderStarted) {
			return;
		}
		window.__manifestLoaderStarted = true;
		cloakWhileParsing({ routes: config.plugins.includes('router'), tabs: config.plugins.includes('tabs') });
		if (config.deriveFromManifest) { let resolve; usageGate = { promise: new Promise(r => { resolve = r; }), resolve }; }

		const MANIFEST_DEPENDENT_PLUGINS = [
			'data', 'localization', 'components',
			'appwrite-auth', 'appwrite-data', 'appwrite-presences', 'payments', 'chat'
		];
		const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';

		// Substitute ${VAR} placeholders against window.env in-place, once,
		// before caching the manifest so every consumer sees resolved values.
		// Inlined (not borrowed from the data plugin, which may not have run
		// yet). window.env comes from mnfst-run (.env PUBLIC_ vars) or an
		// author <script>window.env = {…}</script>. Misses are warned, not
		// dropped — an empty substitution tends to fail far from the cause.
		const warnedMissingEnv = new Set();
		const interpolateManifestEnv = (obj) => {
			if (obj === null || typeof obj !== 'object') return;
			const subst = (str) => str.replace(/\$\{([^}]+)\}/g, (m, name) => {
				if (typeof window !== 'undefined' && window.env && window.env[name] !== undefined) {
					return window.env[name];
				}
				if (!warnedMissingEnv.has(name)) {
					warnedMissingEnv.add(name);
					if (!name.startsWith('PUBLIC_')) {
						console.warn(
							`[Manifest] manifest.json references \${${name}}, but only PUBLIC_-prefixed ` +
							`env vars are injected into window.env by mnfst-run. Rename to ` +
							`PUBLIC_${name}, hardcode the value, or supply it via ` +
							`<script>window.env = {…}</script>. Leaving placeholder literal.`
						);
					} else {
						console.warn(
							`[Manifest] manifest.json references \${${name}}, but it is not present ` +
							`in window.env. Add ${name}=… to .env (read by mnfst-run) or ` +
							`set it via <script>window.env = {…}</script>. Leaving placeholder literal.`
						);
					}
				}
				return m;
			});
			const walk = (o) => {
				if (Array.isArray(o)) {
					for (let i = 0; i < o.length; i++) {
						const v = o[i];
						if (typeof v === 'string') o[i] = subst(v);
						else if (v && typeof v === 'object') walk(v);
					}
				} else {
					for (const k of Object.keys(o)) {
						const v = o[k];
						if (typeof v === 'string') o[k] = subst(v);
						else if (v && typeof v === 'object') walk(v);
					}
				}
			};
			walk(obj);
		};

		// One manifest.json request per boot: published on window the moment it starts so
		// plugins that init before __manifestLoaded is set (data, auth, components) await it
		// instead of fetching their own. Resolves interpolated, or null.
		const shareManifestFetch = () => {
			if (window.__manifestLoaded) return Promise.resolve(window.__manifestLoaded);
			if (!window.__manifestPromise) {
				window.__manifestPromise = fetch(manifestUrl).then(r => r.ok ? r.json() : null)
					.then(m => { if (m && !m.__interpolated) { interpolateManifestEnv(m); Object.defineProperty(m, '__interpolated', { value: true, enumerable: false }); } return m; })
					.catch(() => null);
			}
			return window.__manifestPromise;
		};

		// Fetch hints issued while manifest.json is in flight. Execution order is untouched:
		// the script tags are injected as before and find these responses already cached.
		const hintEarlyFetches = () => {
			// With integrity on, tags carry hashes these hints would not match; a prerender pass snapshots <head>
			if (integrityReady || !document.head || window.__manifestRender === true) return;
			const hinted = new Set();
			const hint = (rel, href, as) => {
				if (!href || hinted.has(rel + href)) return;
				hinted.add(rel + href);
				const link = document.createElement('link');
				link.rel = rel;
				if (as) {
					link.as = as;
					// Low, like the tags they stand in for: never ahead of the manifest-decided modules
					link.setAttribute('fetchpriority', 'low');
				}
				link.href = href;
				link.setAttribute('data-mnfst-hint', '');
				document.head.appendChild(link);
			};
			// Used by then; never left in a saved or prerendered document
			document.addEventListener('alpine:init', () => {
				document.head.querySelectorAll('link[data-mnfst-hint]').forEach(link => link.remove());
			}, { once: true });
			try {
				// manifest.json goes out first: on a shared connection pool it must not queue behind the hints
				if (config.deriveFromManifest || config.plugins.some(p => MANIFEST_DEPENDENT_PLUGINS.includes(p))) shareManifestFetch();
				const first = _pluginBase ? null : CDN_HOSTS[0];
				if (first && new URL(first, location.href).origin !== location.origin) hint('preconnect', new URL(first, location.href).origin);
				if (config.deriveFromManifest) {
					// Loaded whatever the manifest says; the rest wait for it
					const conditional = ['data', 'localization', 'components', 'status'];
					for (const name of [...ALWAYS_ON, ...config.plugins]) {
						if (!conditional.includes(name)) hint('preload', getPluginUrl(name, config.version), 'script');
					}
				}
				// Once the document is parsed, so an author's own Alpine tag is seen
				whenDomReady(() => {
					try {
						if (!window.Alpine && !document.querySelector('script[src*="alpinejs"]')) {
							hint('preload', alpineUrlCandidates(config.alpine)[0], 'script');
						}
						// On-use modules this page uses, while manifest.json may still be in flight
						if (config.deriveFromManifest) {
							const used = sniffBoot().used.filter(p => p !== 'components' && !_omitted.includes(p));
							for (const p of resolveDependencies(used)) if (!config.plugins.includes(p) && !pluginLoads.has(p)) hint('preload', getPluginUrl(p, config.version), 'script');
						}
					} catch (_) { /* optional */ }
				});
			} catch (_) { /* hints are optional */ }
		};

		const loadPlugins = async () => {
			if (integrityReady) {
				if (config.deriveFromManifest || config.plugins.some(p => MANIFEST_DEPENDENT_PLUGINS.includes(p))) shareManifestFetch();
				try {
					await integrityReady;
				} catch (e) {
					if (!e.logged) console.error(`[Manifest Loader] ${e.message}`);
					return;
				}
			}
			let manifest = null;
			let pluginsToLoad = config.plugins;
			let manifestPromise = null;

			if (config.deriveFromManifest) {
				manifest = await shareManifestFetch();
				const corePlugins = getDefaultPluginsFromManifest(manifest);
				const appwritePlugins = detectAppwritePlugins(manifest);
				const paymentsPlugins = detectPaymentsPlugins(manifest);
				const chatPlugins = detectChatPlugins(manifest);
				const nativePlugins = detectNativePlugins(manifest);
				pluginsToLoad = resolveDependencies([...ALWAYS_ON, ...notOmitted([...corePlugins, ...appwritePlugins, ...paymentsPlugins, ...chatPlugins, ...nativePlugins, ...(config.extraPlugins || [])])]);
			} else {
				pluginsToLoad = resolveDependencies([...ALWAYS_ON, ...pluginsToLoad.filter(p => !ALWAYS_ON.includes(p))]);
				const needsManifest = config.plugins.some(p => MANIFEST_DEPENDENT_PLUGINS.includes(p));
				if (needsManifest) {
					manifestPromise = shareManifestFetch();
				}
				// Inside a Capacitor container, ensure the native umbrella loads even on
				// the explicit data-plugins path (matches the derive-path auto-inject).
				if (typeof window !== 'undefined' && window.Capacitor && !pluginsToLoad.includes('device')) {
					pluginsToLoad = resolveDependencies([...pluginsToLoad, 'device']);
				}
			}

			const pluginPromises = pluginsToLoad.map(pluginName => {
				return addScript(pluginName, config.version).catch(error => {
					console.warn(`[Manifest Loader] Failed to load plugin ${pluginName}:`, error);
				});
			});
			// Content fetched before the document is parsed (components) loads its modules now
			if (config.deriveFromManifest) { usageArmed = true; usageGate.resolve(); }
			if (config.tailwind && !staticUtilitiesFullyCovered()) {
				pluginPromises.push(config.tailwindCache
					? tailwindReplay.then(hit => hit ? null : loadTailwind(config.version)).catch(() => { })
					: loadTailwind(config.version).catch(() => { }));
			}
			// Usage sniff once the document is parsed: on-use modules download alongside the
			// rest and run before Alpine. Derive path only — an explicit data-modules list is an
			// intentional constraint, not a default.
			const sniffed = !config.deriveFromManifest ? null : new Promise((resolve) => whenDomReady(() => {
				let late = [];
				try {
					const all = sniffBoot().take();
					// An omitted module the page uses fails far from the cause: say so once
					const blocked = all.filter(p => _omitted.includes(p) && !pluginsToLoad.includes(p));
					blocked.forEach(p => warnedLate.add(p));
					if (blocked.length) console.warn(`[Manifest Loader] data-omit lists ${blocked.join(', ')}, but this page uses ${blocked.length > 1 ? 'them' : 'it'}. Not loaded: remove ${blocked.length > 1 ? 'them' : 'it'} from data-omit to load.`);
					const used = all.filter(p => !pluginsToLoad.includes(p) && !_omitted.includes(p));
					if (used.length > 0) {
						late = resolveDependencies(used).filter(p => !pluginsToLoad.includes(p)).map(p => addScript(p, config.version).catch(error => {
							usageFailed.add(p);
							console.warn(`[Manifest Loader] Failed to load plugin ${p}:`, error);
						}));
					}
				} catch (_) { /* sniffing must never block Alpine */ }
				usageSniff = true;
				watchUsage(config.version);
				resolve(Promise.all(late));
			}));
			await Promise.all(pluginPromises);
			revealParseHiddenPanels();
			settleTailwindCache(config.version);
			if (manifestPromise) {
				manifest = await manifestPromise;
			}
			if (manifest && typeof window !== 'undefined') {
				// Already interpolated by shareManifestFetch; appwrite-auth etc. read window.__manifestLoaded directly.
				window.__manifestLoaded = manifest;
				if (window.ManifestComponentsRegistry) {
					window.ManifestComponentsRegistry.manifest = manifest;
				}
			}
			whenDomReady(async () => {
				if (sniffed) await sniffed;
				startReadyCoordinator(pluginsToLoad, config.tailwind);
				loadAlpine(alpineUrlCandidates(config.alpine));
			});
		};

		// manifest:ready — fires once when the page has visually settled: data
		// sources loaded (manifest:render-ready), first utility compile done
		// (manifest:utilities-ready), and no x-markdown render in flight — held
		// through a short quiet window. Consumers can also check
		// window.__manifestReady. Capped so a wedged signal can't block forever.
		function startReadyCoordinator(plugins, tailwindEnabled) {
			if (window.__manifestReadyCoordinator) return;
			window.__manifestReadyCoordinator = true;
			const release = window.ManifestPending.hold('ready');
			const needData = plugins.some(p => p === 'data' || p === 'appwrite-data');
			const needUtilities = !!tailwindEnabled;
			const state = {
				data: !needData || !!window.__manifestRenderReady,
				utilities: !needUtilities || !!window.__manifestUtilitiesReady,
			};
			let fired = false;
			let quietTimer = null;
			const mdIdle = () => !(window.__manifestMarkdownPending > 0);
			const utilIdle = () => !(window.__manifestUtilitiesPending > 0);
			const fire = () => {
				if (fired) return;
				fired = true;
				release();
				window.__manifestReady = true;
				window.dispatchEvent(new CustomEvent('manifest:ready'));
			};
			const check = () => {
				if (fired) return;
				if (!state.data || !state.utilities || !mdIdle() || !utilIdle()) return;
				clearTimeout(quietTimer);
				quietTimer = setTimeout(() => {
					if (state.data && state.utilities && mdIdle() && utilIdle()) fire();
				}, 300);
			};
			window.addEventListener('manifest:render-ready', () => { state.data = true; check(); });
			window.addEventListener('manifest:utilities-ready', () => { state.utilities = true; check(); });
			window.addEventListener('manifest:utilities-idle', check);
			window.addEventListener('manifest:markdown-idle', check);
			setTimeout(fire, 15000);
			check();
		}

		const tailwindReplay = config.tailwindCache ? replayTailwindCache(config) : null;
		hintEarlyFetches();
		// Never leaves a loadUsed caller waiting, whatever stops the boot
		loadPlugins().finally(() => { if (usageGate) usageGate.resolve(); });
	}
})();
