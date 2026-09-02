/*  Manifest JS
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Loader: pulls Alpine.js and Manifest plugins from the jsDelivr CDN — all
/*  plugins by default, or a subset if specified.
*/

(function () {
	'use strict';

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
	 * `_x_currentIfEl` (avoids re-rendering heavy content); x-for clones are removed.
	 * Runs on alpine:init so a page without Alpine keeps its baked content.
	 */
	function reconcilePrerenderClones() {
		if (typeof document === 'undefined' || !document.querySelectorAll) return;
		document.querySelectorAll('[data-mnfst-prerender-clone]').forEach((el) => {
			if (el.closest && el.closest('[data-hydrate]')) return;
			el.removeAttribute('data-mnfst-prerender-clone');
			const tpl = el.previousElementSibling;
			if (tpl && tpl.tagName === 'TEMPLATE' && tpl.hasAttribute('x-if')) {
				// Alpine's x-if show() returns early when _x_currentIfEl is set.
				tpl._x_currentIfEl = el;
			} else {
				el.remove();
			}
		});
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

	// unpkg serves packages as published (no auto-minify); mnfst ships unminified .js.
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
		'defer',
		'router',
		'utilities',
		'data',
		'icons',
		'localization',
		'markdown',
		'svg',
		'code',
		'color',
		'toasts',
		'tooltips',
		'dropdowns',
		'combobox',
		'computed',
		'tabs',
		'text-edit',
		'slides',
		'resize',
		'colorpicker',
		'datepicker',
		'charts',
		'url-parameters',
		'virtual',
		'export',
		'status'
	];

	// Authoring plugin — opt-in only. Visitors should never pay for editor chrome;
	// load it with data-plugins or Manifest.loadPlugin('edit') behind your own gate.
	const AUTHORING_PLUGINS = ['edit'];

	// Appwrite integration plugins (opt-in only, never auto-loaded)
	const APPWRITE_PLUGINS = [
		'appwrite-auth',
		'appwrite-data',
		'appwrite-presences'
	];

	// Plugin dependencies: plugins that require other plugins to be loaded first
	const PLUGIN_DEPENDENCIES = {
		'appwrite-data': ['data'],
		'appwrite-presences': ['data', 'appwrite-auth'],
		'native': ['utilities']
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
	function getPluginUrlCandidates(pluginName, version = DEFAULT_VERSION) {
		// Hyphenated API name → dotted file name (`appwrite-auth` → appwrite.auth).
		const fileName = pluginName.replace(/-/g, '.');
		if (_pluginBase) {
			const base = _pluginBase.replace(/\/$/, '');
			return [`${base}/manifest.${fileName}.js`];
		}
		return CDN_HOSTS.map(h => `${getBaseUrl(version, h)}/${hostFile(h, `manifest.${fileName}.min.js`)}`);
	}
	function getPluginUrl(pluginName, version = DEFAULT_VERSION) {
		return getPluginUrlCandidates(pluginName, version)[0];
	}

	// Alpine URL candidates from a data-alpine value (version tag or full URL)
	function alpineUrlCandidates(dataAlpine) {
		if (dataAlpine && dataAlpine.startsWith('http')) return [dataAlpine];
		const v = dataAlpine || '3';
		return CDN_HOSTS.map(h => `${h}/alpinejs@${v}/dist/cdn.min.js`);
	}

	// Has DOMContentLoaded fired? readyState can't tell ('interactive' spans
	// both DCL-pending and DCL-done); the navigation timing entry disambiguates.
	function domContentLoadedFired() {
		if (document.readyState === 'complete') return true;
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
			(async () => {
				for (const url of alpineUrls) {
					try {
						return await injectScript(url);
					} catch (_) {
						console.warn(`[Manifest Loader] Alpine failed from ${url} — trying fallback CDN`);
					}
				}
				console.error('[Manifest Loader] Alpine.js failed to load from all CDNs.');
			})();
		});
	}

	// Inject one script URL and wait for it to load and execute
	function injectScript(url) {
		return new Promise((resolve, reject) => {
			// Skip if script with same src already in DOM (e.g. prerendered HTML or second loader run)
			const existing = document.querySelector(`script[src="${url}"]`);
			if (existing) {
				if (existing.complete) return resolve();
				existing.addEventListener('load', () => resolve());
				existing.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)));
				return;
			}

			const script = document.createElement('script');
			script.src = url;
			script.async = false; // Ensure scripts execute in order
			script.onload = () => resolve();
			script.onerror = () => { script.remove(); reject(new Error(`Failed to load ${url}`)); };
			document.head.appendChild(script);
		});
	}

	// Load a plugin, falling through the CDN chain on error. A fallback insert
	// lands after already-inserted scripts, so strict cross-plugin execution
	// order is traded for availability in the (already degraded) fallback case.
	async function addScript(pluginName, version = DEFAULT_VERSION) {
		const urls = getPluginUrlCandidates(pluginName, version);
		let lastErr = null;
		for (const url of urls) {
			try {
				return await injectScript(url);
			} catch (e) {
				lastErr = e;
				if (urls.length > 1) console.warn(`[Manifest Loader] ${url} failed — trying fallback CDN`);
			}
		}
		throw lastErr || new Error(`Failed to load ${pluginName}`);
	}

	// Resolve plugin dependencies (auto-inject required dependencies)
	function resolveDependencies(pluginList) {
		const resolved = [];
		const added = new Set();

		function addPluginWithDeps(plugin) {
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
	const USAGE_PLUGINS = [
		{ magic: '$chat', plugin: 'chat' },
		{ magic: '$presence', plugin: 'appwrite-presences' }
	];
	function detectUsagePlugins(alreadyLoaded) {
		const wanted = USAGE_PLUGINS.filter(u => !alreadyLoaded.includes(u.plugin));
		if (wanted.length === 0 || typeof document === 'undefined') return [];
		const found = new Set();
		const done = () => found.size === wanted.length;

		for (const s of document.querySelectorAll('script:not([src])')) {
			const t = s.textContent || '';
			for (const u of wanted) if (!found.has(u.plugin) && t.includes(u.magic)) found.add(u.plugin);
			if (done()) return [...found];
		}

		const scan = (root) => {
			for (const el of root.querySelectorAll('*')) {
				for (const attr of el.attributes || []) {
					const v = attr.value;
					if (!v || v.indexOf('$') === -1) continue;
					for (const u of wanted) if (!found.has(u.plugin) && v.includes(u.magic)) found.add(u.plugin);
					if (done()) return;
				}
				if (el.tagName === 'TEMPLATE' && el.content) {
					scan(el.content);
					if (done()) return;
				}
			}
		};
		scan(document);
		return [...found];
	}

	// Detect the native umbrella plugin. Auto-loaded inside a Capacitor container
	// (window.Capacitor present) or when a `native` config block opts in on the web.
	function detectNativePlugins(manifest) {
		if (typeof window !== 'undefined' && window.Capacitor) return ['native'];
		if (manifest && typeof manifest === 'object' && manifest.native && typeof manifest.native === 'object') return ['native'];
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

		const plugins = script.getAttribute('data-plugins');
		const omit = script.getAttribute('data-omit');
		const tailwind = script.getAttribute('data-tailwind') !== null;
		const version = script.getAttribute('data-version') || DEFAULT_VERSION;
		const alpine = script.getAttribute('data-alpine');
		// Override: resolve plugin URLs against this base (dir serving
		// `manifest.<name>.js`, relative or absolute) instead of the CDN.
		const pluginBase = script.getAttribute('data-plugin-base');
		// Override: custom CDN fallback chain (comma-separated origins).
		const cdn = script.getAttribute('data-cdn');

		// `data-plugins="a,b"` replaces the default set; a `+` prefix is additive
		// (`data-plugins="+chat"` = defaults plus chat) — needed for plugins with
		// no manifest.json trigger, e.g. chat driven by custom adapters only.
		let pluginList = [];
		let extraPlugins = [];
		let deriveFromManifest = !plugins;

		if (plugins) {
			const entries = plugins.split(',').map(p => p.trim()).filter(p => p);
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
		if (omit && pluginList.length > 0) {
			const omitted = omit.split(',').map(p => p.trim());
			pluginList = pluginList.filter(p => !omitted.includes(p));
		}

		// Resolve dependencies (auto-inject required plugins)
		pluginList = resolveDependencies(pluginList);

		return {
			plugins: pluginList,
			extraPlugins,
			deriveFromManifest,
			tailwind,
			version,
			alpine,
			pluginBase,
			cdn,
		};
	}

	// Load custom Tailwind CDN script, falling through the CDN chain on error
	async function loadTailwind(version = DEFAULT_VERSION) {
		const urls = CDN_HOSTS.map(h => `${getBaseUrl(version, h)}/${hostFile(h, 'manifest.tailwind.min.js')}`);
		let lastErr = null;
		for (const url of urls) {
			try {
				return await injectScript(url);
			} catch (e) {
				lastErr = e;
			}
		}
		console.warn(`[Manifest Loader] Tailwind plugin not available from any CDN. Load it directly: <script src="/scripts/tailwind.v4.3.1.js"></script>`);
		throw lastErr || new Error(`Tailwind plugin not available from CDN.`);
	}

	// Expose API
	window.Manifest = {
		loadPlugin: function (pluginName, version = DEFAULT_VERSION) {
			const allPlugins = [...AVAILABLE_PLUGINS, ...APPWRITE_PLUGINS, ...AUTHORING_PLUGINS, 'payments', 'chat', 'native'];
			if (!allPlugins.includes(pluginName)) {
				console.warn(`[Manifest Loader] Unknown plugin: ${pluginName}`);
				return Promise.reject(new Error(`Unknown plugin: ${pluginName}`));
			}

			// Resolve dependencies for single plugin load
			const pluginList = resolveDependencies([pluginName]);

			// Load plugin and its dependencies
			return Promise.all(pluginList.map(plugin => addScript(plugin, version)));
		},
		loadTailwind: loadTailwind,
		getPluginUrl: getPluginUrl
	};

	// Parse config and load plugins
	const config = parseDataAttributes();
	if (config && config.pluginBase) setPluginBase(config.pluginBase);
	if (config && config.cdn) setCdnHosts(config.cdn);

	if (config && config.plugins.length > 0) {
		if (window.__manifestLoaderStarted) {
			return;
		}
		window.__manifestLoaderStarted = true;

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

		const loadPlugins = async () => {
			let manifest = null;
			let pluginsToLoad = config.plugins;
			let manifestPromise = null;

			if (config.deriveFromManifest) {
				manifest = await fetch(manifestUrl).then(r => r.ok ? r.json() : null).catch(() => null);
				const corePlugins = getDefaultPluginsFromManifest(manifest);
				const appwritePlugins = detectAppwritePlugins(manifest);
				const paymentsPlugins = detectPaymentsPlugins(manifest);
				const chatPlugins = detectChatPlugins(manifest);
				const nativePlugins = detectNativePlugins(manifest);
				pluginsToLoad = resolveDependencies([...corePlugins, ...appwritePlugins, ...paymentsPlugins, ...chatPlugins, ...nativePlugins, ...(config.extraPlugins || [])]);
			} else {
				const needsManifest = config.plugins.some(p => MANIFEST_DEPENDENT_PLUGINS.includes(p));
				if (needsManifest) {
					manifestPromise = fetch(manifestUrl).then(r => r.ok ? r.json() : null).catch(() => null);
				}
				// Inside a Capacitor container, ensure the native umbrella loads even on
				// the explicit data-plugins path (matches the derive-path auto-inject).
				if (typeof window !== 'undefined' && window.Capacitor && !pluginsToLoad.includes('native')) {
					pluginsToLoad = resolveDependencies([...pluginsToLoad, 'native']);
				}
			}

			const pluginPromises = pluginsToLoad.map(pluginName => {
				return addScript(pluginName, config.version).catch(error => {
					console.warn(`[Manifest Loader] Failed to load plugin ${pluginName}:`, error);
				});
			});
			if (config.tailwind) {
				pluginPromises.push(loadTailwind(config.version).catch(() => { }));
			}
			await Promise.all(pluginPromises);
			if (manifestPromise) {
				manifest = await manifestPromise;
			}
			if (manifest && typeof window !== 'undefined') {
				// Resolve ${VAR} before any plugin reads the cached manifest —
				// appwrite-auth etc. read window.__manifestLoaded directly.
				interpolateManifestEnv(manifest);
				window.__manifestLoaded = manifest;
				if (window.ManifestComponentsRegistry) {
					window.ManifestComponentsRegistry.manifest = manifest;
				}
			}
			// Usage sniff: Alpine is DCL-gated anyway, so the parsed document can
			// be checked for magics with no declarative trigger and the missing
			// plugins fetched before Alpine boots. Derive path only — an explicit
			// data-plugins list is an intentional constraint, not a default.
			whenDomReady(async () => {
				if (config.deriveFromManifest) {
					try {
						const used = detectUsagePlugins(pluginsToLoad);
						if (used.length > 0) {
							const late = resolveDependencies(used).filter(p => !pluginsToLoad.includes(p));
							await Promise.all(late.map(p => addScript(p, config.version).catch(error => {
								console.warn(`[Manifest Loader] Failed to load plugin ${p}:`, error);
							})));
						}
					} catch (_) { /* sniffing must never block Alpine */ }
				}
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

		loadPlugins();
	}
})();
