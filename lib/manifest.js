/*  Manifest JS
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Lightweight loader that dynamically loads Alpine.js and Manifest plugins
/*  from jsDelivr CDN. Loads all plugins by default, or a subset if specified.
/*
/*  Some plugins use Manifest CSS styles.
*/

(function () {
	'use strict';

	/*
	 * Hydration contract runtime
	 * --------------------------
	 * Prerendered MPA pages carry a `<script type="application/json"
	 * id="__manifest_hydrate__">` blob containing the source-authored
	 * attributes (and, for explicit `data-hydrate` subtrees, the source
	 * innerHTML) of every element that needs runtime hydration.  This
	 * function runs once on page load BEFORE any plugin or Alpine starts —
	 * it walks the contract, restores source state, and removes its own
	 * markers.  Every downstream plugin (colors, router, data, markdown,
	 * icons, …) then sees exactly the DOM the user authored, exactly as it
	 * would in a live SPA.  No plugin needs a "prerender mode" branch.
	 *
	 * Implementation notes:
	 *  - We use a temp-div HTML parse to set attributes because `setAttribute`
	 *    throws InvalidCharacterError on Alpine special names like `@click`.
	 *    The HTML parser is lenient and accepts them.
	 *  - The contract is a compact diff: only attributes whose values drifted
	 *    from source during prerender appear.  An entry's `attrs` object maps
	 *    attribute name -> source value, or null to mean "remove".
	 */
	function hydratePrerenderedPage() {
		if (typeof document === 'undefined' || !document.querySelector) return;
		// Only run on pages the prerender marked as static MPA output.
		const prerenderMeta = document.querySelector('meta[name="manifest:prerendered"]');
		if (!prerenderMeta || prerenderMeta.getAttribute('content') === '0') return;

		// Remove baked x-for/x-if clones the prerender kept for crawlers.  Their
		// <template> is still live, so Alpine re-renders the list/conditional on
		// boot; dropping the baked copies first (before Alpine runs) avoids a
		// duplicate render.  data-hydrate islands keep their baked DOM.
		document.querySelectorAll('[data-mnfst-prerender-clone]').forEach((el) => {
			if (el.closest && el.closest('[data-hydrate]')) return;
			el.remove();
		});

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

		// Restore deepest-first so that when an ancestor rebuilds its innerHTML,
		// its children have already been restored and their source state is what
		// the ancestor captures.
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

			// Case 1: explicit subtree restoration (entry.html present).
			// Rebuild the element from scratch via outerHTML replacement so the
			// entire subtree mirrors the authored source.
			if (typeof entry.html === 'string') {
				const tag = el.tagName.toLowerCase();
				const finalAttrs = {};
				// Start from current attrs, then apply the contract diff.
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

			// Case 2: attribute-only diff.  Reparse the element with the merged
			// attribute set (current attrs overlaid by source diff) so that
			// special-name attributes like @click work.  Preserve innerHTML.
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

	// Run hydration BEFORE Alpine's deferred script executes.
	//
	// Timing: `<script defer>` runs AFTER HTML parsing finishes but BEFORE
	// `DOMContentLoaded` fires.  So listening for DOMContentLoaded is too late —
	// Alpine has already walked the tree and attached directives by then, and
	// our `replaceChild`-based restore would destroy the Alpine-bound nodes.
	//
	// The only earlier hook is `readystatechange → 'interactive'`, which is
	// dispatched the moment the parser finishes and BEFORE deferred scripts run.
	// We also run synchronously if readyState is already 'interactive' or later
	// (e.g. if manifest.js was injected dynamically after page load).
	function tryHydrate() {
		try { hydratePrerenderedPage(); } catch (e) { /* graceful */ }
	}
	if (typeof document !== 'undefined') {
		if (document.readyState === 'loading') {
			// We're still parsing.  Listen for 'interactive' via readystatechange
			// — this is the earliest moment document.body is guaranteed to exist
			// but deferred scripts haven't run yet.
			let hydrated = false;
			document.addEventListener('readystatechange', () => {
				if (!hydrated && document.readyState !== 'loading') {
					hydrated = true;
					tryHydrate();
				}
			});
		} else {
			// Parser already done (interactive or complete).  Hydrate immediately.
			tryHydrate();
		}
	}

	// Configuration
	const DEFAULT_VERSION = 'latest';
	const ALPINE_CDN_URL = 'https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js';

	// Get base URL for a given version
	function getBaseUrl(version = DEFAULT_VERSION) {
		return `https://cdn.jsdelivr.net/npm/mnfst@${version}/lib`;
	}

	// Available core plugins (auto-loaded if no data-plugins specified)
	const AVAILABLE_PLUGINS = [
		'components',
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
		'tabs',
		'slides',
		'resize',
		'colorpicker',
		'url-parameters',
		'export'
	];

	// Appwrite integration plugins (opt-in only, never auto-loaded)
	const APPWRITE_PLUGINS = [
		'appwrite-auth',
		'appwrite-data',
		'appwrite-presence'
	];

	// Plugin dependencies: plugins that require other plugins to be loaded first
	const PLUGIN_DEPENDENCIES = {
		'appwrite-data': ['data'],
		'appwrite-presence': ['data']
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
		return AVAILABLE_PLUGINS.filter(p => {
			if (p === 'data') return hasData;
			if (p === 'localization') return hasLocalization;
			if (p === 'components') return hasComponents;
			return true;
		});
	}

	// Get plugin URL from CDN or the `data-plugin-base` override.  When the
	// loader's <script> tag carries `data-plugin-base="/scripts"` (or an
	// absolute URL), plugins are loaded from that base as unminified `.js`
	// files.  Otherwise they come from the jsDelivr CDN as `.min.js`.
	let _pluginBase = null;
	function setPluginBase(b) { _pluginBase = b || null; }
	function getPluginUrl(pluginName, version = DEFAULT_VERSION) {
		// Map hyphenated plugin API names to their dotted file names.
		// `appwrite-auth` → `manifest.appwrite.auth.js`
		// `url-parameters` → `manifest.url.parameters.js`
		const fileName = pluginName.replace(/-/g, '.');
		if (_pluginBase) {
			const base = _pluginBase.replace(/\/$/, '');
			return `${base}/manifest.${fileName}.js`;
		}
		const base = getBaseUrl(version);
		return `${base}/manifest.${fileName}.min.js`;
	}

	// Resolve Alpine CDN URL from a data-alpine value (version tag or full URL)
	function resolveAlpineUrl(dataAlpine) {
		if (!dataAlpine) return ALPINE_CDN_URL;
		if (dataAlpine.startsWith('http')) return dataAlpine;
		return `https://cdn.jsdelivr.net/npm/alpinejs@${dataAlpine}/dist/cdn.min.js`;
	}

	// Load Alpine.js from CDN.  Called by the loader AFTER all plugin scripts
	// have finished loading and registered their directives/magics.  We do
	// NOT use `defer` here — defer fires at DOMContentLoaded, which may race
	// the plugin loads; instead we wait for every plugin script's load event
	// explicitly and then append Alpine synchronously (the script downloads
	// but Alpine's `auto-start` hooks DOMContentLoaded if still loading, or
	// runs immediately if past it).
	function loadAlpine(alpineUrl = ALPINE_CDN_URL) {
		// Fast check: Alpine already initialized
		if (window.Alpine) {
			return;
		}

		// Fallback: if an existing Alpine <script> tag is already in the DOM
		// (e.g. the fixture explicitly added one), wait for it — don't inject
		// a second copy.
		const existingAlpine = document.querySelector('script[src*="alpinejs"]');
		if (existingAlpine) {
			return;
		}

		const script = document.createElement('script');
		script.src = alpineUrl;
		// No `defer` — we're already past plugin registration, so Alpine
		// should load and execute as soon as it arrives.
		document.head.appendChild(script);
	}

	// Add a script tag to the head and wait for it to load and execute
	function addScript(pluginName, version = DEFAULT_VERSION) {
		return new Promise((resolve, reject) => {
			const url = getPluginUrl(pluginName, version);

			// Skip if script with same src already in DOM (e.g. prerendered HTML or second loader run)
			const existing = document.querySelector(`script[src="${url}"]`);
			if (existing) {
				if (existing.complete) return resolve();
				existing.addEventListener('load', () => resolve());
				existing.addEventListener('error', () => reject(new Error(`Failed to load ${pluginName} from ${url}`)));
				return;
			}

			const script = document.createElement('script');
			script.src = url;
			script.async = false; // Ensure scripts execute in order
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`Failed to load ${pluginName} from ${url}`));
			document.head.appendChild(script);
		});
	}

	// Resolve plugin dependencies (auto-inject required dependencies)
	function resolveDependencies(pluginList) {
		const resolved = [];
		const added = new Set();

		// Helper to add a plugin and its dependencies in correct order
		function addPluginWithDeps(plugin) {
			if (added.has(plugin)) return;

			// First, add all dependencies
			const deps = PLUGIN_DEPENDENCIES[plugin];
			if (deps) {
				for (const dep of deps) {
					if (!added.has(dep)) {
						addPluginWithDeps(dep);
					}
				}
			}

			// Then add the plugin itself
			resolved.push(plugin);
			added.add(plugin);
		}

		// Process all plugins in order, ensuring dependencies come first
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
		if (manifest.data?.presence?.appwriteTableId) {
			plugins.push('appwrite-presence');
		}
		return plugins;
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
		// Optional override: when present, plugin URLs are resolved against
		// this base instead of the CDN.  Useful for self-hosted deployments
		// and for the e2e harness which needs to load locally-built plugins.
		// The base should point at a directory that serves `manifest.<name>.js`
		// files.  It can be relative (e.g. "/scripts") or absolute.
		const pluginBase = script.getAttribute('data-plugin-base');

		let pluginList = [];
		const deriveFromManifest = !plugins;

		if (plugins) {
			// Explicit declaration - load only specified plugins (core + Appwrite)
			pluginList = plugins.split(',').map(p => p.trim()).filter(p => p);
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
			deriveFromManifest,
			tailwind,
			version,
			alpine,
			pluginBase,
		};
	}

	// Load custom Tailwind CDN script
	function loadTailwind(version = DEFAULT_VERSION) {
		return new Promise((resolve, reject) => {
			const base = getBaseUrl(version);
			const tailwindUrl = `${base}/manifest.tailwind.min.js`;

			// Check if already loaded
			const existing = document.querySelector(`script[src="${tailwindUrl}"]`);
			if (existing && existing.complete) {
				return resolve();
			}

			const script = document.createElement('script');
			script.src = tailwindUrl;
			script.async = false;
			script.onload = () => resolve();
			script.onerror = () => {
				console.warn(`[Manifest Loader] Tailwind plugin not yet published to CDN. Load it directly: <script src="/scripts/tailwind.v4.1.js"></script>`);
				reject(new Error(`Tailwind plugin not available from CDN. Load it directly from your project.`));
			};
			document.head.appendChild(script);
		});
	}

	// Expose API
	window.Manifest = {
		loadPlugin: function (pluginName, version = DEFAULT_VERSION) {
			const allPlugins = [...AVAILABLE_PLUGINS, ...APPWRITE_PLUGINS];
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

	if (config && config.plugins.length > 0) {
		if (window.__manifestLoaderStarted) {
			return;
		}
		window.__manifestLoaderStarted = true;

		const MANIFEST_DEPENDENT_PLUGINS = [
			'data', 'localization', 'components',
			'appwrite-auth', 'appwrite-data', 'appwrite-presence'
		];
		const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';

		// Substitute ${VAR} placeholders against window.env in every string
		// value of the parsed manifest, in place. Called once before the
		// manifest is cached on window so every downstream consumer
		// (auth, data, components, etc.) sees resolved values. Inlined in
		// the loader rather than borrowed from the data plugin because the
		// data plugin's script may not have finished executing yet at the
		// point we cache the manifest. window.env is populated by either
		// the mnfst-run dev server (which reads .env at startup) or a
		// developer-supplied <script>window.env = {…}</script> block.
		const interpolateManifestEnv = (obj) => {
			if (obj === null || typeof obj !== 'object') return;
			const subst = (str) => str.replace(/\$\{([^}]+)\}/g, (m, name) => {
				if (typeof window !== 'undefined' && window.env && window.env[name] !== undefined) {
					return window.env[name];
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
				pluginsToLoad = resolveDependencies([...corePlugins, ...appwritePlugins]);
			} else {
				const needsManifest = config.plugins.some(p => MANIFEST_DEPENDENT_PLUGINS.includes(p));
				if (needsManifest) {
					manifestPromise = fetch(manifestUrl).then(r => r.ok ? r.json() : null).catch(() => null);
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
				// Resolve ${VAR} placeholders once, here, before any
				// downstream plugin reads the cached manifest. Plugins like
				// appwrite-auth read window.__manifestLoaded directly and
				// would otherwise see literal `${APPWRITE_DEV_KEY}` strings
				// even when window.env is populated.
				interpolateManifestEnv(manifest);
				window.__manifestLoaded = manifest;
				if (window.ManifestComponentsRegistry) {
					window.ManifestComponentsRegistry.manifest = manifest;
				}
			}
			loadAlpine(resolveAlpineUrl(config.alpine));
		};

		loadPlugins();
	}
})();
