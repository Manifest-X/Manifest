/*  Manifest Charts — in-house SVG chart renderer (themeable, prerender-safe, a11y).
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*  d3-scale/shape/array micro-modules (ISC) lazy-loaded from esm.run on scroll-in.
*/

(function () {
	'use strict';

	/* Shared localized-UI resolver: deep-merges every loaded source's `_ui[component]`
	 * onto the plugin's English fallbacks. Guarded; byte-identical across the picker
	 * copies (first plugin to load defines it). */
	if (!window.ManifestUI) {
		window.ManifestUI = {
			/* Loaded data sources (current locale); never force-loads others. */
			_loadedSourceNames() {
				try {
					const store = window.ManifestDataStore && window.ManifestDataStore.rawDataStore;
					if (store && typeof store.keys === 'function') return [...store.keys()];
				} catch (_) { }
				return [];
			},
			/* Reads inside the caller's Alpine effect (if any) so $x/$locale stay reactive. */
			resolve(component, fallbacks) {
				const merged = JSON.parse(JSON.stringify(fallbacks || {}));
				try {
					if (!window.Alpine || typeof Alpine.evaluate !== 'function') return merged;
					try { Alpine.evaluate(document.body, '$locale && $locale.current'); } catch (_) { } // dep → re-resolve on locale switch
					for (const name of this._loadedSourceNames()) {
						let ui;
						try { ui = Alpine.evaluate(document.body, `$x['${name}'] && $x['${name}']._ui && $x['${name}']._ui['${component}']`); } catch (_) { ui = null; }
						if (ui && typeof ui === 'object' && !Array.isArray(ui)) this._deepOverlay(merged, ui);
					}
				} catch (_) { }
				return merged;
			},
			_deepOverlay(target, src) {
				for (const k of Object.keys(src)) {
					if (k.startsWith('$') || k === 'contentType' || k === 'valueOf' || k === 'toString') continue;
					const v = src[k];
					if (typeof v === 'function') continue;
					if (v && typeof v === 'object' && !Array.isArray(v)) {
						if (!target[k] || typeof target[k] !== 'object') target[k] = {};
						this._deepOverlay(target[k], v);
					} else if (v !== undefined && v !== null && v !== '') {
						target[k] = v;
					}
				}
			}
		};
	}

	const SVGNS = 'http://www.w3.org/2000/svg';

	// Lazy localized country names per locale (i18n-iso-countries, keyed by
	// alpha-2). Falls back to {} (English atlas names) if a locale isn't covered.
	const _namePacks = {}, _namePackPromise = {};
	function loadCountryNames(locale) {
		if (_namePacks[locale]) return Promise.resolve(_namePacks[locale]);
		if (_namePackPromise[locale]) return _namePackPromise[locale];
		_namePackPromise[locale] = fetch('https://cdn.jsdelivr.net/npm/i18n-iso-countries@7/langs/' + locale + '.json')
			.then(r => r.json()).then(d => (_namePacks[locale] = d.countries || {}))
			.catch(() => (_namePacks[locale] = {}));
		return _namePackPromise[locale];
	}

	/* ---- Lazy-load d3 micro-modules once ---------------------------- */
	let d3Promise = null;
	function loadD3() {
		if (window.__manifestD3) return Promise.resolve(window.__manifestD3);
		if (d3Promise) return d3Promise;
		d3Promise = Promise.all([
			import('https://esm.run/d3-scale@4'),
			import('https://esm.run/d3-shape@3'),
			import('https://esm.run/d3-array@3')
		]).then(([scale, shape, array]) => {
			const d3 = { ...scale, ...shape, ...array };
			window.__manifestD3 = d3;
			return d3;
		}).catch((err) => { d3Promise = null; throw err; });
		return d3Promise;
	}

	const prefersReducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };

	// Reconcile the ~20 Natural Earth atlas names that differ from the
	// country-by-continent source so every rendered country lands in a continent.
	const _norm = s => String(s || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
	const ATLAS_CONT = { 'fiji': 'Oceania', 'w sahara': 'Africa', 'united states of america': 'North America', 'dem rep congo': 'Africa', 'dominican rep': 'North America', 'falkland is': 'South America', 'fr s antarctic lands': 'Antarctica', 'timor-leste': 'Asia', "côte d'ivoire": 'Africa', 'central african rep': 'Africa', 'eq guinea': 'Africa', 'solomon is': 'Oceania', 'taiwan': 'Asia', 'czechia': 'Europe', 'n cyprus': 'Asia', 'somaliland': 'Africa', 'bosnia and herz': 'Europe', 'macedonia': 'Europe', 'kosovo': 'Europe', 's sudan': 'Africa' };

	/* ---- World map: lazy-load d3-geo + topojson + reference data ----
	   Geometry (world-atlas) plus ISO codes (i18n-iso-countries) and
	   continent membership (country-json) — all third-party CDN, fetched
	   once and indexed onto `geo.meta`. No geographic tables are bundled. */
	let geoPromise = null;
	function loadGeo() {
		if (window.__manifestGeo) return Promise.resolve(window.__manifestGeo);
		if (geoPromise) return geoPromise;
		geoPromise = Promise.all([
			import('https://esm.run/d3-geo@3'),
			import('https://esm.run/topojson-client@3'),
			fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(r => r.json()),
			fetch('https://cdn.jsdelivr.net/npm/i18n-iso-countries@7/codes.json').then(r => r.json()),
			fetch('https://cdn.jsdelivr.net/npm/country-json/src/country-by-continent.json').then(r => r.json())
		]).then(([geo, topo, world, codes, contList]) => {
			const a2 = {}, a3 = {}, num2a2 = {};
			codes.forEach(c => { const n = Number(c[2]); if (!n) return; a2[c[0]] = n; a3[c[1]] = n; num2a2[n] = c[0]; });
			const nameToCont = {}; contList.forEach(r => { nameToCont[_norm(r.country)] = r.continent; });
			const members = {}, idToCont = {};
			(world.objects.countries.geometries || []).forEach(gm => {
				const id = Number(gm.id), nm = _norm(gm.properties && gm.properties.name);
				const cont = nameToCont[nm] || ATLAS_CONT[nm];
				if (cont) { idToCont[id] = cont; (members[cont] = members[cont] || []).push(id); }
			});
			const g = { ...geo, topojson: topo, world, meta: { a2, a3, num2a2, members, idToCont } };
			window.__manifestGeo = g;
			return g;
		}).catch((err) => { geoPromise = null; throw err; });
		return geoPromise;
	}

	function initializeChartsPlugin() {
		const Alpine = window.Alpine;
		const _registry = Alpine.reactive ? Alpine.reactive({}) : {};
		let _uid = 0;

		const _nullApi = { type: '', series: [], update() { }, redraw() { }, toString() { return ''; }, valueOf() { return ''; } };

		function findAncestorState(el) { let n = el; while (n) { if (n._chartState) return n._chartState; n = n.parentElement; } return null; }

		/* ---- One shared IntersectionObserver: defer load until visible ---- */
		let io = null;
		function observer() {
			if (io) return io;
			io = new IntersectionObserver((entries, obs) => {
				for (const e of entries) {
					if (!e.isIntersecting) continue;
					const t = e.target;
					if (typeof t.checkVisibility === 'function' && !t.checkVisibility()) continue;
					obs.unobserve(t);
					const state = t._chartState;
					if (state) state.activate();
				}
			}, { rootMargin: '100px', threshold: 0 });
			return io;
		}

		/* ---- Config normalization ----------------------------------- */
		function num(v, d) { const n = Number(v); return isNaN(n) ? d : n; }

		// Timeline values: Date → ms, number → as-is, string → parsed date (or
		// numeric fallback). NaN when absent.
		function toTime(v) {
			if (v == null) return NaN;
			if (v instanceof Date) return v.getTime();
			if (typeof v === 'number') return v;
			const t = Date.parse(v);
			return isNaN(t) ? Number(v) : t;
		}
		function chartLocale() {
			try { return Alpine.store('locale')?.current || document.documentElement.lang || 'en'; } catch (_) { return 'en'; }
		}

		function configFromDom(el) {
			// Declarative authoring: <figure x-chart.line><data series="Revenue" :values="..."></data></figure>
			const cfg = { series: [], labels: [] };
			const labelsAttr = el.getAttribute('labels');
			if (labelsAttr) { try { cfg.labels = Alpine.evaluate(el, labelsAttr); } catch (_) { } }
			el.querySelectorAll(':scope > data, :scope > .chart-series').forEach((node) => {
				if (node.hasAttribute('labels')) {
					const lx = node.getAttribute(':values') || node.getAttribute('values') || node.getAttribute('labels');
					try { cfg.labels = Alpine.evaluate(el, lx); } catch (_) { }
					return;
				}
				const name = node.getAttribute('series') || node.getAttribute('name') || '';
				const valExpr = node.getAttribute(':values') || node.getAttribute('values');
				let data = [];
				if (valExpr) { try { data = Alpine.evaluate(el, valExpr) || []; } catch (_) { data = []; } }
				const color = node.getAttribute('color') || node.getAttribute(':color') || '';
				cfg.series.push({ name, data: Array.isArray(data) ? data : [], color });
			});
			return cfg;
		}

		function normalize(raw, el, typeFromModifier) {
			const cfg = Object.assign({}, raw || {});
			cfg.type = (cfg.type || typeFromModifier || 'line').toLowerCase();
			cfg.height = num(cfg.height || el.getAttribute('height'), 240);
			cfg.stacked = !!cfg.stacked;
			cfg.legend = cfg.legend !== false;
			cfg.axis = cfg.axis !== false;
			cfg.grid = cfg.grid !== false;
			cfg.tooltip = cfg.tooltip !== false;   // hover tooltips on by default
			cfg.dataLabels = !!cfg.dataLabels;       // static value labels off by default
			cfg.gap = num(cfg.gap, 1);               // heatmap tile gutter in px
			cfg.labels = Array.isArray(cfg.labels) ? cfg.labels : [];

			// Series may be omitted in favor of a single `data` array. (A map's
			// `data` is a region→value object, left untouched for drawMap.)
			if (!cfg.series && Array.isArray(cfg.data) && cfg.type !== 'map') cfg.series = [{ name: cfg.name || '', data: cfg.data }];
			if (!Array.isArray(cfg.series)) cfg.series = [];

			if (cfg.type === 'map') cfg.map = cfg.map || 'world';

			// Pie/donut: accept [{label,value}] in data.
			if ((cfg.type === 'pie' || cfg.type === 'donut') && cfg.series.length) {
				const s = cfg.series[0];
				if (Array.isArray(s.data) && s.data.length && typeof s.data[0] === 'object') {
					cfg.labels = s.data.map(d => d.label);
					s.data = s.data.map(d => num(d.value, 0));
				}
			}

			// Gantt: series are tracks of time/numeric/category segments.
			// (`timeline` accepted as a legacy alias.)
			if (cfg.type === 'gantt' || cfg.type === 'timeline') {
				cfg.type = 'gantt';
				cfg.rowHeight = num(cfg.rowHeight, 28);
				cfg.markers = Array.isArray(cfg.markers) ? cfg.markers : [];
			}

			// Gauge: a single value, from `value` or the first series datum.
			if (cfg.type === 'gauge') {
				if (cfg.value != null && !cfg.series.length) cfg.series = [{ data: [num(cfg.value, 0)] }];
				cfg.min = num(cfg.min, 0);
				cfg.max = num(cfg.max, 100);
			}
			return cfg;
		}

		/* ---- SVG helpers -------------------------------------------- */
		function svg(tag, attrs, parent) {
			const node = document.createElementNS(SVGNS, tag);
			if (attrs) for (const k in attrs) { if (attrs[k] != null) node.setAttribute(k, attrs[k]); }
			if (parent) parent.appendChild(node);
			return node;
		}
		function text(parent, str, attrs) {
			const t = svg('text', attrs, parent);
			t.appendChild(document.createTextNode(str == null ? '' : String(str))); // untrusted-safe
			return t;
		}
		// Entry animations run only on first draw; redraws paint final state directly
		// (else a bound value change replays the reveal every frame). Set by drawChart.
		let _suppressAnim = false;
		function animate(el, keyframes, opts) {
			if (_suppressAnim || prefersReducedMotion() || typeof el.animate !== 'function') return;
			try { el.animate(keyframes, Object.assign({ duration: 600, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'backwards' }, opts)); } catch (_) { }
		}
		// Cursor-following tooltip: x-tooltip's CSS anchor positioning can't target SVG
		// children (no layout box), so charts use their own themed tip. aria-label for AT.
		function applyTip(seg, tip, cfg) {
			seg.setAttribute('aria-label', tip);
			if (!cfg.tooltip) return;
			// .chart marker, not [x-chart] — modified directives (x-chart.line)
			// are a different attribute name and closest() can't prefix-match.
			const host = seg.closest('.chart');
			if (!host) return;
			const show = (e) => {
				const state = host._chartState; if (!state) return;
				let t = state.tip;
				if (!t || !t.isConnected) { t = document.createElement('div'); t.className = 'tooltip'; t.setAttribute('role', 'tooltip'); host.appendChild(t); state.tip = t; }
				t.textContent = tip; // untrusted-safe
				t.classList.add('active');
				const rect = host.getBoundingClientRect(), half = (t.offsetWidth || 0) / 2;
				const x = Math.max(half + 2, Math.min(e.clientX - rect.left, rect.width - half - 2));
				t.style.left = x + 'px';
				t.style.top = (e.clientY - rect.top) + 'px';
			};
			seg.addEventListener('mouseenter', show);
			seg.addEventListener('mousemove', show);
			seg.addEventListener('mouseleave', () => { const t = host._chartState && host._chartState.tip; if (t) t.classList.remove('active'); });
		}
		function dataLabel(parent, str, x, y, anchor, baseline, cls) {
			return text(parent, str, { class: 'value' + (cls ? ' ' + cls : ''), x: x, y: y, 'text-anchor': anchor || 'middle', 'dominant-baseline': baseline || 'auto' });
		}

		/* ---- Per-chart state ---------------------------------------- */
		function createState(el, expression, modifiers) {
			const state = {
				el, expression, typeFromModifier: modifiers[0],
				id: el.id || ('mnfst-chart-' + (++_uid)),
				config: null, d3: null, active: false, _raf: 0,

				get api() {
					const self = this;
					return {
						get type() { return self.config ? self.config.type : ''; },
						get series() { return self.config ? self.config.series : []; },
						update(cfg) { self.config = normalize(cfg, self.el, self.typeFromModifier); self.draw(); },
						redraw() { self.draw(); },
						toString() { return self.config ? self.config.type : ''; }
					};
				},

				activate() {
					if (this.active) return;
					this.active = true;
					loadD3().then(d3 => { this.d3 = d3; this.bindReactive(); })
						.catch(() => { this.renderError('Chart engine failed to load.'); });
				},

				bindReactive() {
					const self = this;
					const getCfg = self.expression ? Alpine.evaluateLater(self.el, self.expression) : null;
					Alpine.effect(() => {
						// Subscribe to the data store heartbeat so $x loads/locale reloads re-run.
						try { void Alpine.store('data')?._dataVersion; } catch (_) { }
						if (getCfg) getCfg(raw => { self.config = normalize(raw, self.el, self.typeFromModifier); self.schedule(); });
						else { self.config = normalize(configFromDom(self.el), self.el, self.typeFromModifier); self.schedule(); }
					});
					// Re-render on locale (axis number/date formatting) and container resize.
					self._onLocale = () => self.schedule();
					window.addEventListener('localechange', self._onLocale);
					self._ro = new ResizeObserver(() => self.schedule());
					self._ro.observe(self.el);
					if (self.el.id) _registry[self.el.id] = self.api;
				},

				// One draw per tick. setTimeout (not rAF) so backgrounded tabs still draw;
				// doesn't reset a pending timer, so a high-frequency trigger can't starve it.
				schedule() { if (this._t) return; this._t = setTimeout(() => { this._t = null; this.draw(); }, 0); },

				renderError(msg) { this.el.innerHTML = ''; const d = document.createElement('small'); d.textContent = msg; this.el.appendChild(d); },

				draw() { drawChart(this); }
			};
			return state;
		}

		/* ---- Main draw ---------------------------------------------- */
		function drawChart(state) {
			const cfg = state.config; const d3 = state.d3; const el = state.el;
			if (!cfg || !d3) return;
			const width = Math.max(120, el.clientWidth || el.getBoundingClientRect().width || 600);

			// Maps have their own data shape, async geo deps, and aspect-based
			// height — handled before the cartesian/series path.
			if (cfg.type === 'map') {
				el.innerHTML = ''; probePalette(el);
				const geo = window.__manifestGeo;
				if (!geo) {
					el.style.minHeight = (cfg.height || 320) + 'px';
					loadGeo().then(() => state.schedule()).catch(() => state.renderError('Map data failed to load.'));
					return;
				}
				_suppressAnim = !!state._drawn; state._drawn = true;
				const mh = cfg.height || Math.round(width * 0.52);
				el.style.minHeight = mh + 'px';
				const mroot = svg('svg', { viewBox: `0 0 ${width} ${mh}`, width: '100%', height: String(mh), role: 'img', 'aria-label': cfg.title || 'map', preserveAspectRatio: 'xMidYMid meet' }, el);
				drawMap(state, mroot, width, mh, geo);
				return;
			}

			// Gantt sizes by track count, not a fixed height.
			const height = cfg.type === 'gantt' ? ganttHeight(cfg) : cfg.height;
			if (cfg.type === 'gantt') el.style.minHeight = height + 'px';

			el.innerHTML = '';
			probePalette(el);

			const hasData = cfg.series.some(s => Array.isArray(s.data) && s.data.length);
			if (!hasData) { const d = document.createElement('small'); d.textContent = 'No data'; el.appendChild(d); return; }

			// Animate the reveal only on the first paint; redraws snap to state.
			_suppressAnim = !!state._drawn;
			state._drawn = true;

			// Label via aria-label (not an SVG <title>, which renders a native
			// browser tooltip that conflicts with our cursor tooltip).
			const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: String(height), role: 'img', 'aria-label': cfg.title || (cfg.type + ' chart'), preserveAspectRatio: 'xMidYMid meet' }, el);

			if (cfg.type === 'pie' || cfg.type === 'donut') drawPie(state, root, width, height);
			else if (cfg.type === 'gauge') drawGauge(state, root, width, height);
			else if (cfg.type === 'heatmap') drawHeatmap(state, root, width, height);
			else if (cfg.type === 'gantt') drawGantt(state, root, width, height);
			else drawCartesian(state, root, width, height);
		}

		// Gantt height derives from track count (one lane per series) + axis.
		function ganttHeight(cfg) {
			const n = Math.max(1, (cfg.series || []).length);
			return 4 + n * cfg.rowHeight + 22;
		}

		// Palette size = count of consecutive --color-chart-N tokens (themes may extend
		// past 8); colours cycle through them. Re-probed per draw for per-scope overrides.
		let _paletteN = 8;
		function probePalette(el) {
			try {
				const cs = getComputedStyle(el);
				let n = 0;
				while (n < 32 && cs.getPropertyValue('--color-chart-' + (n + 1)).trim()) n++;
				_paletteN = n || 8;
			} catch (_) { _paletteN = 8; }
		}
		function seriesColorVar(i, explicit) { return explicit || `var(--color-chart-${(i % _paletteN) + 1})`; }

		// Resolve the theme --radius token to user-space px (the viewBox is 1:1
		// with CSS px), so SVG corners match the rest of the UI's rounding.
		function cssRadius(el) {
			try {
				const v = getComputedStyle(el).getPropertyValue('--radius').trim() || '0.5rem';
				if (v.endsWith('rem')) return parseFloat(v) * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
				if (v.endsWith('px')) return parseFloat(v);
				return parseFloat(v) || 8;
			} catch (_) { return 8; }
		}

		// Line interpolation: monotone (smooth, default) | linear | step | natural.
		function curveFor(d3, name) {
			switch (String(name || '').toLowerCase()) {
				case 'linear': case 'straight': return d3.curveLinear;
				case 'step': case 'stepped': return d3.curveStep;
				case 'step-after': return d3.curveStepAfter;
				case 'step-before': return d3.curveStepBefore;
				case 'natural': case 'spline': return d3.curveNatural;
				default: return d3.curveMonotoneX;
			}
		}

		// Per-series chart type (for combo): explicit `type` on the series, else
		// the chart-level type.
		function seriesType(cfg, s) { return (s && s.type) || (cfg.type === 'combo' ? 'bar' : cfg.type); }

		// Parse OHLC rows: {o/open,h/high,l/low,c/close} or [o,h,l,c].
		function candleData(data) {
			return (data || []).map(d => Array.isArray(d)
				? { o: num(d[0], 0), h: num(d[1], 0), l: num(d[2], 0), c: num(d[3], 0) }
				: { o: num(d.o != null ? d.o : d.open, 0), h: num(d.h != null ? d.h : d.high, 0), l: num(d.l != null ? d.l : d.low, 0), c: num(d.c != null ? d.c : d.close, 0) });
		}

		function drawCartesian(state, root, width, height) {
			const cfg = state.config, d3 = state.d3;
			const m = { top: 10, right: 14, bottom: 26, left: 40 };
			const iw = width - m.left - m.right;
			const ih = height - m.top - m.bottom;
			const labels = cfg.labels.length ? cfg.labels : cfg.series[0].data.map((_, i) => i + 1);
			const locale = (() => { try { return Alpine.store('locale')?.current || document.documentElement.lang || 'en'; } catch (_) { return 'en'; } })();
			const nf = (() => { try { return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }); } catch (_) { return { format: String }; } })();

			const isCandle = cfg.type === 'candlestick' || cfg.type === 'ohlc';

			// y domain
			let yMax = -Infinity, yMin = 0;
			if (isCandle) {
				const cs = candleData(cfg.series[0].data);
				yMin = Infinity; yMax = -Infinity;
				cs.forEach(c => { if (c.l < yMin) yMin = c.l; if (c.h > yMax) yMax = c.h; });
				const padY = (yMax - yMin) * 0.05 || 1; yMin -= padY; yMax += padY;
			} else if (cfg.stacked && (cfg.type === 'bar' || cfg.type === 'area')) {
				const n = labels.length;
				for (let i = 0; i < n; i++) { let sum = 0; cfg.series.forEach(s => sum += num(s.data[i], 0)); if (sum > yMax) yMax = sum; }
			} else {
				// In combo, only line/area/bar series carry plain numeric data.
				cfg.series.forEach(s => (s.data || []).forEach(v => { if (v && typeof v === 'object') return; const n = num(v, 0); if (n > yMax) yMax = n; if (n < yMin) yMin = n; }));
			}
			if (yMax === -Infinity) yMax = 1;
			if (yMax === yMin) yMax += 1;

			const y = d3.scaleLinear().domain(isCandle ? [yMin, yMax] : [Math.min(0, yMin), yMax]).nice().range([ih, 0]);
			const plot = svg('g', { transform: `translate(${m.left},${m.top})` }, root);

			// Grid + y axis ticks
			if (cfg.grid || cfg.axis) {
				const ticks = y.ticks(5);
				ticks.forEach(t => {
					const yy = y(t);
					if (cfg.grid) svg('line', { x1: 0, x2: iw, y1: yy, y2: yy }, plot);
					if (cfg.axis) text(plot, nf.format(t), { x: -8, y: yy, 'text-anchor': 'end', 'dominant-baseline': 'central' });
				});
			}

			if (isCandle) drawCandles(state, plot, labels, iw, ih, y);
			else if (cfg.type === 'combo') drawCombo(state, plot, labels, iw, ih, y);
			else if (cfg.type === 'bar') drawBars(state, plot, labels, iw, ih, y);
			else if (cfg.type === 'scatter') drawScatter(state, plot, labels, iw, ih, y);
			else drawLines(state, plot, labels, iw, ih, y); // line + area

			// x axis labels (banded)
			if (cfg.axis) {
				const xb = d3.scaleBand().domain(labels.map(String)).range([0, iw]).padding(0.1);
				labels.forEach(l => {
					const cx = xb(String(l)) + xb.bandwidth() / 2;
					text(plot, l, { x: cx, y: ih + 16, 'text-anchor': 'middle' });
				});
			}
			if (cfg.legend && cfg.series.length > 1) drawLegend(state);
		}

		// `list` lets combo pass a subset of series with their original indices
		// (preserving colours/legend). Defaults to every series.
		function drawLines(state, plot, labels, iw, ih, y, list) {
			const cfg = state.config, d3 = state.d3;
			const x = d3.scalePoint().domain(labels.map(String)).range([0, iw]).padding(0.5);
			const curve = curveFor(d3, cfg.curve);
			const items = list || cfg.series.map((s, i) => ({ s, i, area: cfg.type === 'area' }));
			items.forEach(({ s, i: si, area }) => {
				const color = seriesColorVar(si, s.color);
				const points = labels.map((l, i) => [x(String(l)), y(num(s.data[i], 0))]);
				if (area) {
					const areaGen = d3.area().x(p => p[0]).y0(ih).y1(p => p[1]).curve(curve);
					const ap = svg('path', { class: 'area', d: areaGen(points), style: `--color-chart-color:${color}` }, plot);
					animate(ap, [{ opacity: 0 }, { opacity: 1 }], { duration: 500 });
				}
				const line = d3.line().x(p => p[0]).y(p => p[1]).curve(curve);
				const lp = svg('path', { class: 'line', d: line(points), style: `--color-chart-color:${color}`, fill: 'none' }, plot);
				try { const len = lp.getTotalLength(); animate(lp, [{ strokeDashoffset: len, strokeDasharray: len }, { strokeDashoffset: 0, strokeDasharray: len }], { duration: 700 }); } catch (_) { }
				// points
				points.forEach((p, i) => {
					const dot = svg('circle', { cx: p[0], cy: p[1], r: 3, style: `--color-chart-color:${color}` }, plot);
					const v = num(s.data[i], 0);
					applyTip(dot, (s.name ? s.name + ': ' : '') + v, cfg);
					animate(dot, [{ opacity: 0, transform: 'scale(0)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 300, delay: 200 + i * 20 });
					if (cfg.dataLabels) dataLabel(plot, v, p[0], p[1] - 8);
				});
			});
		}

		// `list` (combo) is a subset of {s,i} keeping original indices. Stacking
		// only applies to the full-series bar chart, not combo.
		function drawBars(state, plot, labels, iw, ih, y, list) {
			const cfg = state.config, d3 = state.d3;
			const x0 = d3.scaleBand().domain(labels.map(String)).range([0, iw]).padding(0.2);
			if (cfg.stacked && !list) {
				labels.forEach((l, i) => {
					let acc = 0;
					cfg.series.forEach((s, si) => {
						const v = num(s.data[i], 0);
						const yTop = y(acc + v), yBot = y(acc);
						const rect = svg('rect', { x: x0(String(l)), y: yTop, width: x0.bandwidth(), height: Math.max(0, yBot - yTop), style: `--color-chart-color:${seriesColorVar(si, s.color)}` }, plot);
						applyTip(rect, (s.name ? s.name + ': ' : '') + v, cfg);
						animateBar(rect, ih);
						if (cfg.dataLabels && (yBot - yTop) > 14) dataLabel(plot, v, x0(String(l)) + x0.bandwidth() / 2, (yTop + yBot) / 2, 'middle', 'central', 'inverse');
						acc += v;
					});
				});
			} else {
				const items = list || cfg.series.map((s, i) => ({ s, i }));
				const x1 = d3.scaleBand().domain(items.map((_, k) => String(k))).range([0, x0.bandwidth()]).padding(0.08);
				labels.forEach((l, i) => {
					items.forEach((o, k) => {
						const s = o.s, si = o.i;
						const v = num(s.data[i], 0);
						const yy = y(Math.max(0, v));
						const rect = svg('rect', { x: x0(String(l)) + x1(String(k)), y: yy, width: x1.bandwidth(), height: Math.abs(y(v) - y(0)), style: `--color-chart-color:${seriesColorVar(si, s.color)}` }, plot);
						applyTip(rect, (s.name ? s.name + ': ' : '') + v, cfg);
						animateBar(rect, ih);
						if (cfg.dataLabels) dataLabel(plot, v, x0(String(l)) + x1(String(k)) + x1.bandwidth() / 2, yy - 4);
					});
				});
			}
		}

		// Combo: bars (grouped among bar series) + line/area overlays, shared axes.
		function drawCombo(state, plot, labels, iw, ih, y) {
			const cfg = state.config;
			const bars = [], lines = [];
			cfg.series.forEach((s, i) => {
				const t = seriesType(cfg, s);
				if (t === 'line' || t === 'area') lines.push({ s, i, area: t === 'area' });
				else bars.push({ s, i });
			});
			if (bars.length) drawBars(state, plot, labels, iw, ih, y, bars);
			if (lines.length) drawLines(state, plot, labels, iw, ih, y, lines);
		}

		// Candlestick / OHLC.
		function drawCandles(state, plot, labels, iw, ih, y) {
			const cfg = state.config, d3 = state.d3;
			const cs = candleData(cfg.series[0].data);
			const x0 = d3.scaleBand().domain(labels.map(String)).range([0, iw]).padding(0.3);
			const bw = x0.bandwidth();
			cs.forEach((c, i) => {
				const cx = x0(String(labels[i])) + bw / 2;
				const up = c.c >= c.o;
				const g = svg('g', { class: up ? 'positive' : 'negative' }, plot);
				svg('line', { x1: cx, x2: cx, y1: y(c.h), y2: y(c.l) }, g);
				const yTop = Math.min(y(c.o), y(c.c)), bodyH = Math.max(1, Math.abs(y(c.c) - y(c.o)));
				const rect = svg('rect', { x: cx - bw * 0.3, y: yTop, width: bw * 0.6, height: bodyH }, g);
				applyTip(rect, `${labels[i]} · O ${c.o} H ${c.h} L ${c.l} C ${c.c}`, cfg);
				animate(g, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: i * 15 });
			});
		}
		function animateBar(rect, ih) {
			if (_suppressAnim || prefersReducedMotion() || typeof rect.animate !== 'function') return;
			rect.style.transformBox = 'fill-box'; rect.style.transformOrigin = 'center bottom';
			try { rect.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 600, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'backwards' }); } catch (_) { }
		}

		function drawScatter(state, plot, labels, iw, ih, y) {
			const cfg = state.config, d3 = state.d3;
			const x = d3.scalePoint().domain(labels.map(String)).range([0, iw]).padding(0.5);
			cfg.series.forEach((s, si) => {
				labels.forEach((l, i) => {
					const v = num(s.data[i], 0);
					const dot = svg('circle', { class: 'scatter', cx: x(String(l)), cy: y(v), r: 5, style: `--color-chart-color:${seriesColorVar(si, s.color)}` }, plot);
					applyTip(dot, (s.name ? s.name + ': ' : '') + v, cfg);
					animate(dot, [{ opacity: 0, transform: 'scale(0)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 350, delay: i * 25 });
					if (cfg.dataLabels) dataLabel(plot, v, x(String(l)), y(v) - 9);
				});
			});
		}

		function drawPie(state, root, width, height) {
			const cfg = state.config, d3 = state.d3;
			const data = cfg.series[0].data.map(v => num(v, 0));
			const labels = cfg.labels.length ? cfg.labels : data.map((_, i) => i + 1);
			const r = Math.min(width, height) / 2 - 6;
			const inner = cfg.type === 'donut' ? r * 0.6 : 0;
			const g = svg('g', { transform: `translate(${width / 2},${height / 2})` }, root);
			const pie = d3.pie().sort(null).value(d => d)(data);
			const arc = d3.arc().innerRadius(inner).outerRadius(r);
			pie.forEach((slice, i) => {
				const path = svg('path', { class: 'slice', d: arc(slice), style: `--color-chart-color:${seriesColorVar(i)}` }, g);
				applyTip(path, labels[i] + ': ' + data[i], cfg);
				if (cfg.dataLabels) { const c = arc.centroid(slice); dataLabel(g, data[i], c[0], c[1], 'middle', 'central', 'inverse'); }
				if (!_suppressAnim && !prefersReducedMotion() && typeof path.animate === 'function') {
					path.style.transformBox = 'fill-box'; path.style.transformOrigin = 'center';
					try { path.animate([{ opacity: 0, transform: 'scale(0.85)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 450, delay: i * 60, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'backwards' }); } catch (_) { }
				}
			});
			if (cfg.legend) drawLegend(state, labels);
		}

		// Widest rendered label in px (exact via getComputedTextLength, char-estimate
		// fallback). Sizes axis gutters to their content so charts sit balanced.
		function labelWidth(root, items, cls) {
			if (!items || !items.length) return 0;
			const probe = svg('text', cls ? { class: cls, x: -9999, y: -9999 } : { x: -9999, y: -9999 }, root);
			let max = 0;
			for (const s of items) { probe.textContent = String(s); let w = 0; try { w = probe.getComputedTextLength(); } catch (_) { } if (!w) w = String(s).length * 7; if (w > max) max = w; }
			root.removeChild(probe);
			return Math.ceil(max);
		}

		function drawGauge(state, root, width, height) {
			const cfg = state.config, d3 = state.d3;
			const value = num(cfg.series[0] && cfg.series[0].data[0], 0);
			const min = cfg.min, max = cfg.max;
			const START = -Math.PI / 2, END = Math.PI / 2;
			const scale = d3.scaleLinear().domain([min, max]).range([START, END]).clamp(true);
			const unit = cfg.unit || '';

			// Reserve a band below the dial for the min/max labels, then centre the
			// whole dial (arc + labels) within the frame so nothing spills out.
			const PAD = 8, labelBand = cfg.axis ? 20 : 0;
			const r = Math.max(0, Math.min(width / 2 - PAD, height - PAD - labelBand));
			const thickness = Math.max(8, r * 0.22);
			const cx = width / 2, cy = Math.max(PAD, (height - (r + labelBand)) / 2) + r;
			const g = svg('g', { transform: `translate(${cx},${cy})` }, root);
			const arc = d3.arc().innerRadius(r - thickness).outerRadius(r).cornerRadius(cssRadius(state.el));

			// Track, or threshold zone bands when `zones` is given.
			if (Array.isArray(cfg.zones) && cfg.zones.length) {
				let from = min;
				cfg.zones.forEach((z, i) => {
					const to = num(z.to, max);
					svg('path', { class: 'gauge-track', d: arc({ startAngle: scale(from), endAngle: scale(to) }), style: `--color-chart-color:${z.color || seriesColorVar(i)}`, opacity: 0.35 }, g);
					from = to;
				});
			} else {
				svg('path', { class: 'gauge-track', d: arc({ startAngle: START, endAngle: END }) }, g);
			}

			// Value arc — final geometry set unconditionally, so a background tab that
			// skips the fade reveal still renders correctly.
			const color = (cfg.series[0] && cfg.series[0].color) || 'var(--color-chart-1)';
			const valueAngle = scale(value);
			const vArc = svg('path', { class: 'gauge-value', d: arc({ startAngle: START, endAngle: valueAngle }), style: `--color-chart-color:${color}` }, g);
			applyTip(vArc, (cfg.title ? cfg.title + ': ' : '') + value + unit, cfg);
			animate(vArc, [{ opacity: 0 }, { opacity: 1 }], { duration: 500 });

			// Centered readout + range end labels.
			text(g, value + unit, { class: 'gauge-label', x: 0, y: -r * 0.12, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
			if (cfg.axis) {
				const lr = r - thickness / 2;
				text(g, String(min), { x: -lr, y: 16, 'text-anchor': 'middle' });
				text(g, String(max), { x: lr, y: 16, 'text-anchor': 'middle' });
			}
		}

		// Heatmap — matrix of cells (row per series, column per datum). Cell colour is a
		// CSS color-mix of the --color-chart-heat-* tokens via a per-cell `--heat` %.
		function drawHeatmap(state, root, width, height) {
			const cfg = state.config, d3 = state.d3;
			const rows = cfg.series;
			const cols = cfg.labels.length ? cfg.labels : (rows[0] && Array.isArray(rows[0].data) ? rows[0].data.map((_, i) => i + 1) : []);
			const rowName = (r, i) => r.name || String(i + 1);
			const showLabels = cfg.axis;

			// Gutters sized to content: a uniform pad all round, plus a left gutter
			// measured to the row labels so the grid sits balanced, not lopsided.
			const PAD = 8;
			const yW = showLabels ? labelWidth(root, rows.map((r, i) => rowName(r, i)), '') : 0;
			const m = { top: PAD, right: PAD, bottom: showLabels ? PAD + 16 : PAD, left: showLabels ? PAD + yW + 8 : PAD };
			const iw = width - m.left - m.right;
			const ih = height - m.top - m.bottom;
			// Tiles abut (padding 0); the gutter comes from insetting each rect
			// by `gap` px (config, default 1; set 0 for a seamless field).
			const gap = Math.max(0, cfg.gap);
			const x = d3.scaleBand().domain(cols.map(String)).range([0, iw]).padding(0);
			const yb = d3.scaleBand().domain(rows.map(rowName)).range([0, ih]).padding(0);
			const cw = Math.max(0, x.bandwidth() - gap), ch = Math.max(0, yb.bandwidth() - gap);

			// Value domain across every cell.
			let lo = Infinity, hi = -Infinity;
			rows.forEach(r => (r.data || []).forEach(v => { const n = num(v, 0); if (n < lo) lo = n; if (n > hi) hi = n; }));
			if (!isFinite(lo)) { lo = 0; hi = 1; }
			if (lo === hi) hi = lo + 1;

			const plot = svg('g', { transform: `translate(${m.left},${m.top})` }, root);

			// Round only the grid's outer corners: square tiles clipped to one rounded
			// rect hugging the cell extent (so the radius doesn't clip empty gutter).
			const clipId = 'mnfst-heat-' + (++_uid);
			const cp = svg('clipPath', { id: clipId }, svg('defs', null, root));
			svg('rect', { x: 0, y: 0, width: Math.max(0, iw - gap), height: Math.max(0, ih - gap), rx: cssRadius(state.el) }, cp);
			const cellsG = svg('g', { 'clip-path': `url(#${clipId})` }, plot);

			rows.forEach((r, ri) => {
				const yy = yb(rowName(r, ri));
				cols.forEach((c, ci) => {
					const v = num(r.data[ci], 0);
					const t = Math.round(((v - lo) / (hi - lo)) * 100);
					const cell = svg('rect', { class: 'heat-cell', x: x(String(c)), y: yy, width: cw, height: ch, style: `--heat:${t}%` }, cellsG);
					applyTip(cell, (r.name ? r.name + ' · ' : '') + c + ': ' + v, cfg);
					animate(cell, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: (ri + ci) * 20 });
					if (cfg.dataLabels) dataLabel(plot, v, x(String(c)) + x.bandwidth() / 2, yy + yb.bandwidth() / 2, 'middle', 'central', 'inverse');
				});
			});

			if (showLabels) {
				rows.forEach((r, ri) => text(plot, rowName(r, ri), { x: -8, y: yb(rowName(r, ri)) + yb.bandwidth() / 2, 'text-anchor': 'end', 'dominant-baseline': 'central' }));
				cols.forEach(c => text(plot, c, { x: x(String(c)) + x.bandwidth() / 2, y: ih + 16, 'text-anchor': 'middle' }));
			}

			if (cfg.legend) drawHeatLegend(state, lo, hi, m);
		}

		// Continuous gradient legend for the heatmap: low label, ramp bar, high
		// label. Padded to the chart's margins so the bar spans the grid width
		// (bar flexes to fill — see .heat-legend in the CSS).
		function drawHeatLegend(state, lo, hi, m) {
			const footer = document.createElement('footer');
			footer.className = 'heat-legend';
			footer.style.paddingLeft = m.left + 'px';
			footer.style.paddingRight = m.right + 'px';
			const a = document.createElement('span'); a.textContent = lo;
			const bar = document.createElement('i');
			const b = document.createElement('span'); b.textContent = hi;
			footer.append(a, bar, b);
			state.el.appendChild(footer);
		}

		// Gantt — each series is a track of `{ from, to, status?, label?, color? }`
		// segments on a shared X axis, adapting numbers→linear, dates→time, else
		// category. A `to`-less segment is a point marker.
		function drawGantt(state, root, width, height) {
			const cfg = state.config, d3 = state.d3;
			const tracks = cfg.series;
			const trackName = (t, i) => t.name || String(i + 1);
			const showLabels = cfg.axis;
			const unit = cfg.unit || '';
			// Uniform pad all round; left gutter measured to the track labels, and
			// extra headroom when markers carry a label drawn above the lanes.
			const PAD = 8;
			const hasMarkerLabels = Array.isArray(cfg.markers) && cfg.markers.some(mk => mk && mk.label);
			const yW = showLabels ? labelWidth(root, tracks.map((t, i) => trackName(t, i)), 'gantt-track') : 0;
			const m = { top: PAD + (hasMarkerLabels ? 10 : 0), right: PAD, bottom: 22, left: showLabels ? PAD + yW + 8 : PAD };
			let iw = width - m.left - m.right;
			const ih = height - m.top - m.bottom;

			// Axis kind from the first segment's `from`.
			let firstFrom;
			for (const t of tracks) { if (t.data && t.data.length) { firstFrom = t.data[0].from; break; } }
			const mode = (firstFrom instanceof Date) ? 'time'
				: typeof firstFrom === 'number' ? 'numeric'
					: (!isNaN(Date.parse(firstFrom)) ? 'time' : 'category');

			// Domain is width-independent; the scale (and its ticks) is built from
			// the current `iw` so it can be rebuilt after reserving label gutters.
			let categoryDomain, dmin, dmax, conv, fmtBase;
			if (mode === 'category') {
				const seen = [];
				tracks.forEach(t => (t.data || []).forEach(s => [s.from, s.to].forEach(v => { if (v != null && seen.indexOf(String(v)) < 0) seen.push(String(v)); })));
				categoryDomain = (cfg.labels && cfg.labels.length) ? cfg.labels.map(String) : seen;
				fmtBase = v => String(v);
			} else {
				conv = mode === 'time' ? toTime : (v => num(v, 0));
				dmin = Infinity; dmax = -Infinity;
				tracks.forEach(t => (t.data || []).forEach(s => {
					const a = conv(s.from), b = conv(s.to != null ? s.to : s.from);
					if (a < dmin) dmin = a; if (b > dmax) dmax = b;
				}));
				if (cfg.min != null) dmin = conv(cfg.min);
				if (cfg.max != null) dmax = conv(cfg.max);
				if (!isFinite(dmin) || !isFinite(dmax) || dmin === dmax) { dmin = 0; dmax = 1; }
				fmtBase = mode === 'time' ? ganttFmt(dmin, dmax) : (v => String(v) + unit);
			}
			const buildX = () => {
				if (mode === 'category') { const sc = d3.scalePoint().domain(categoryDomain).range([0, iw]); return { pos: v => sc(String(v)), ticks: categoryDomain, fmt: fmtBase }; }
				const sc = (mode === 'time' ? d3.scaleTime() : d3.scaleLinear()).domain([dmin, dmax]).range([0, iw]);
				return { pos: v => sc(conv(v)), ticks: sc.ticks(Math.max(2, Math.floor(iw / 80))), fmt: fmtBase };
			};
			let X = buildX();
			// Reserve half of each end label so the natural (middle-anchored) edge
			// ticks sit fully inside the frame — no overflow, no crushing.
			if (showLabels && X.ticks.length) {
				const halfFirst = Math.ceil(labelWidth(root, [X.fmt(X.ticks[0])]) / 2);
				const halfLast = Math.ceil(labelWidth(root, [X.fmt(X.ticks[X.ticks.length - 1])]) / 2);
				let changed = false;
				if (PAD + halfFirst > m.left) { m.left = PAD + halfFirst; changed = true; }
				if (PAD + halfLast > m.right) { m.right = PAD + halfLast; changed = true; }
				if (changed) { iw = width - m.left - m.right; X = buildX(); }
			}
			const pos = X.pos, ticks = X.ticks, fmt = X.fmt;
			const tipVal = v => mode === 'time' ? fmt(toTime(v)) : String(v) + (mode === 'numeric' ? unit : '');

			const lane = ih / Math.max(1, tracks.length);
			const pad = Math.min(6, lane * 0.18);
			const plot = svg('g', { transform: `translate(${m.left},${m.top})` }, root);

			// Grid lines + axis ticks (shared, at the bottom). Labels sit naturally
			// centred on their tick — the reserved gutters keep the ends inside.
			ticks.forEach(tk => {
				const xx = pos(tk);
				if (xx == null || isNaN(xx)) return;
				if (cfg.grid) svg('line', { x1: xx, x2: xx, y1: 0, y2: ih }, plot);
				text(plot, fmt(tk), { x: xx, y: ih + 14, 'text-anchor': 'middle' });
			});

			// Status → colour, stable across tracks. A per-segment `color` wins;
			// else the config `colors` map; else the palette in first-seen order.
			const statusColors = {}; let next = 0;
			const colorFor = (s) => {
				if (s.color) return s.color;
				if (s.status == null) return seriesColorVar(0);
				if (!(s.status in statusColors)) statusColors[s.status] = (cfg.colors && cfg.colors[s.status]) || seriesColorVar(next++);
				return statusColors[s.status];
			};

			tracks.forEach((t, ti) => {
				const y0 = ti * lane, by = y0 + pad, bh = Math.max(0, lane - pad * 2);
				if (showLabels) text(plot, trackName(t, ti), { class: 'gantt-track', x: -8, y: y0 + lane / 2, 'text-anchor': 'end', 'dominant-baseline': 'central' });
				(t.data || []).forEach(s => {
					const x1 = pos(s.from);
					if (x1 == null || isNaN(x1)) return;
					const x2 = s.to != null ? pos(s.to) : x1;
					const color = colorFor(s);
					const label = s.status != null ? s.status : (s.label || '');
					if (!(x2 > x1)) {
						const pt = svg('rect', { class: 'gantt-point', x: x1 - 1.5, y: by, width: 3, height: bh, style: `--color-chart-color:${color}` }, plot);
						applyTip(pt, (t.name ? t.name + ' · ' : '') + label + ' · ' + tipVal(s.from), cfg);
						return;
					}
					const seg = svg('rect', { class: 'gantt-segment', x: x1, y: by, width: Math.max(1, x2 - x1), height: bh, style: `--color-chart-color:${color}` }, plot);
					applyTip(seg, (t.name ? t.name + ' · ' : '') + label + ' · ' + tipVal(s.from) + ' – ' + tipVal(s.to), cfg);
					animate(seg, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: ti * 30 });
					if (cfg.dataLabels && label && (x2 - x1) > 26) dataLabel(plot, label, (x1 + x2) / 2, y0 + lane / 2, 'middle', 'central', 'inverse');
				});
			});

			// Reference markers (e.g. a "now" line).
			cfg.markers.forEach(mk => {
				const xx = pos(mk.at);
				if (!(xx >= 0 && xx <= iw)) return;
				svg('line', { class: 'gantt-marker', x1: xx, x2: xx, y1: 0, y2: ih, style: mk.color ? `--color-chart-color:${mk.color}` : '' }, plot);
				if (mk.label) text(plot, mk.label, { class: 'gantt-marker-label', x: xx, y: -1, 'text-anchor': 'middle' });
			});

			// Status legend (categorical), when more than one is present.
			const statuses = Object.keys(statusColors);
			if (cfg.legend && statuses.length > 1) drawSwatchLegend(state, statuses.map(name => ({ name, color: statusColors[name] })));
		}

		// Axis/tooltip date formatter sized to the visible span.
		function ganttFmt(dmin, dmax) {
			const DAY = 86400000, span = dmax - dmin;
			const opts = span <= 2 * DAY ? { hour: '2-digit', minute: '2-digit' }
				: span <= 120 * DAY ? { month: 'short', day: 'numeric' }
					: { month: 'short', year: 'numeric' };
			let f; try { f = new Intl.DateTimeFormat(chartLocale(), opts); } catch (_) { f = null; }
			return v => f ? f.format(new Date(v)) : new Date(v).toISOString().slice(0, 16);
		}

		/* ---- World map (choropleth) --------------------------------- */
		// Resolve an author key to country numeric id(s): numeric ISO, alpha-2,
		// alpha-3, continent (name or code → all members), or country name (atlas
		// names + a few common aliases). Returns [] when unresolved.
		const _mapAlias = { 'united states': 'united states of america', usa: 'united states of america', 'u.s.': 'united states of america', uk: 'united kingdom', 'great britain': 'united kingdom', russia: 'russia', czechia: 'czechia', 'czech republic': 'czechia', 'south korea': 'south korea', 'north korea': 'north korea', 'dr congo': 'dem. rep. congo', 'democratic republic of the congo': 'dem. rep. congo', tanzania: 'tanzania', bolivia: 'bolivia', laos: 'laos' };
		const _contAlias = { 'n. america': 'north america', 'n america': 'north america', 's. america': 'south america', 's america': 'south america' };
		let _nameIdx = null;
		function nameIndex(geo) {
			if (_nameIdx) return _nameIdx;
			_nameIdx = {};
			geo.world.objects.countries.geometries.forEach(g => { if (g.properties && g.properties.name) _nameIdx[String(g.properties.name).toLowerCase()] = Number(g.id); });
			Object.keys(_mapAlias).forEach(a => { const id = _nameIdx[_mapAlias[a]]; if (id != null) _nameIdx[a] = id; });
			return _nameIdx;
		}
		function resolveRegion(key, geo) {
			const k = String(key).trim(); if (!k) return { kind: '', ids: [] };
			if (/^\d+$/.test(k)) return { kind: 'country', ids: [Number(k)] };
			const meta = geo.meta || {}, up = k.toUpperCase(), low = k.toLowerCase();
			if (k.length === 2 && meta.a2 && meta.a2[up] != null) return { kind: 'country', ids: [meta.a2[up]] };
			if (k.length === 3 && meta.a3 && meta.a3[up] != null) return { kind: 'country', ids: [meta.a3[up]] };
			const members = meta.members || {};
			const cont = Object.keys(members).find(c => c.toLowerCase() === (_contAlias[low] || low));
			if (cont) return { kind: 'continent', code: cont, ids: members[cont] };
			const id = nameIndex(geo)[low];
			return id != null ? { kind: 'country', ids: [id] } : { kind: '', ids: [] };
		}

		// Choropleth: country (or continent-grouped) regions coloured sequentially
		// (numeric values → heat ramp) or categorically (string values → palette).
		function drawMap(state, root, width, height, geo) {
			const cfg = state.config;
			const fc = geo.topojson.feature(geo.world, geo.world.objects.countries);
			const projection = geo.geoNaturalEarth1().fitSize([width, height], fc);
			const path = geo.geoPath(projection);

			// Author data: an object { key: value } or an array of { id|code|name, value } / [key, value].
			let entries = [];
			if (Array.isArray(cfg.data)) entries = cfg.data.map(d => Array.isArray(d) ? [d[0], d[1]] : [d.id != null ? d.id : (d.code != null ? d.code : d.name), d.value]);
			else if (cfg.data && typeof cfg.data === 'object') entries = Object.entries(cfg.data);

			const valueById = {};
			entries.forEach(([key, val]) => resolveRegion(key, geo).ids.forEach(id => { valueById[id] = val; }));

			// Display name: `_ui.map.regions` override → localized pack ($locale) →
			// English atlas name. Async packs trigger a redraw on arrival.
			const num2a2 = (geo.meta && geo.meta.num2a2) || {};
			const locale = chartLocale();
			const ui = (window.ManifestUI && window.ManifestUI.resolve) ? window.ManifestUI.resolve('map', {}) : {};
			const overrides = ui.regions || {};
			let pack = null;
			if (locale && locale !== 'en') { if (_namePacks[locale]) pack = _namePacks[locale]; else loadCountryNames(locale).then(() => state.schedule()); }
			const displayName = (id, eng) => {
				const a2 = num2a2[id];
				if (a2 != null && overrides[a2] != null) return overrides[a2];
				if (overrides[id] != null) return overrides[id];
				if (overrides[String(id)] != null) return overrides[String(id)];
				if (overrides[eng] != null) return overrides[eng];
				if (pack && a2 && pack[a2]) return pack[a2];
				return eng;
			};

			// Author-supplied place gazetteer (config `places` or `_ui.map.cities`) for
			// resolving point names → coords. No city data is bundled.
			const placesSrc = cfg.places || ui.cities || null;
			let places = null;
			if (placesSrc) { places = {}; Object.keys(placesSrc).forEach(k => { places[k.toLowerCase()] = placesSrc[k]; }); }

			// Sequential when every value is numeric, else categorical.
			const vals = entries.map(e => e[1]);
			const numeric = vals.length > 0 && vals.every(v => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(+v)));
			let lo = Infinity, hi = -Infinity;
			if (numeric) { Object.values(valueById).forEach(v => { const n = +v; if (n < lo) lo = n; if (n > hi) hi = n; }); if (!isFinite(lo)) { lo = 0; hi = 1; } if (lo === hi) hi = lo + 1; }
			const palette = {}; let pIdx = 0;

			const plot = svg('g', {}, root);
			fc.features.forEach(f => {
				const id = Number(f.id), v = valueById[id];
				const region = svg('path', { class: 'map-region', d: path(f) }, plot);
				const name = displayName(id, (f.properties && f.properties.name) || String(id));
				if (v != null && v !== '') {
					if (numeric) { const t = Math.round((+v - lo) / (hi - lo) * 100); region.setAttribute('style', `--color-chart-color:color-mix(in oklch, var(--color-chart-heat-high) ${t}%, var(--color-chart-heat-low))`); }
					else { if (!(v in palette)) palette[v] = seriesColorVar(pIdx++); region.setAttribute('style', `--color-chart-color:${palette[v]}`); }
					applyTip(region, name + ': ' + v, cfg);
					animate(region, [{ opacity: 0 }, { opacity: 1 }], { duration: 250 });
				} else {
					applyTip(region, name, cfg);
				}
			});

			// Point markers (proportional symbols) — projected through the same
			// projection. `points: [{ lat, lng, value?, label?, color? }]`, or a
			// `name` resolved against `places` (`city` is a legacy alias).
			const pts = Array.isArray(cfg.points) ? cfg.points : [];
			if (pts.length) {
				const placeKey = (p) => String(p.name != null ? p.name : (p.city != null ? p.city : '')).toLowerCase();
				const coord = (p) => {
					let lat = p.lat != null ? p.lat : p.latitude;
					let lng = p.lng != null ? p.lng : (p.lon != null ? p.lon : (p.long != null ? p.long : p.longitude));
					if ((lat == null || lng == null) && places) {
						const hit = places[placeKey(p)];
						if (hit) { if (Array.isArray(hit)) { lat = hit[0]; lng = hit[1]; } else { lat = hit.lat; lng = hit.lng; } }
					}
					return (lat == null || lng == null) ? null : [+lng, +lat];
				};
				const pv = pts.map(p => p.value);
				const sized = pv.length > 0 && pv.every(v => typeof v === 'number');
				let pmin = Infinity, pmax = -Infinity;
				if (sized) { pv.forEach(v => { if (v < pmin) pmin = v; if (v > pmax) pmax = v; }); if (!isFinite(pmin)) { pmin = 0; pmax = 1; } if (pmin === pmax) pmax = pmin + 1; }
				const rOf = (v) => sized ? 3 + Math.sqrt((+v - pmin) / (pmax - pmin)) * 13 : 4;
				pts.forEach(p => {
					const c = coord(p), xy = c && projection(c);
					if (!xy) return;
					const label = p.label || p.name || p.city || '';
					const dot = svg('circle', { class: 'map-point', cx: xy[0], cy: xy[1], r: rOf(p.value), style: p.color ? `--color-chart-color:${p.color}` : '' }, plot);
					applyTip(dot, label + (p.value != null ? (label ? ': ' : '') + p.value : ''), cfg);
					animate(dot, [{ opacity: 0 }, { opacity: 1 }], { duration: 250 });
				});
			}

			if (cfg.legend) {
				if (numeric) drawHeatLegend(state, Math.round(lo), Math.round(hi), { left: 8, right: 8 });
				else if (entries.length) { const items = Object.keys(palette).map(name => ({ name, color: palette[name] })); if (items.length) drawSwatchLegend(state, items); }
			}
		}

		// Categorical swatch legend from an explicit [{ name, color }] list
		// (gantt statuses carry their own colour, unlike series legends).
		function drawSwatchLegend(state, items) {
			const footer = document.createElement('footer');
			items.forEach(it => {
				const item = document.createElement('span');
				const sw = document.createElement('i');
				sw.style.setProperty('--color-chart-color', it.color);
				const tx = document.createElement('span');
				tx.textContent = it.name;
				item.append(sw, tx); footer.appendChild(item);
			});
			state.el.appendChild(footer);
		}

		// Legend is a <footer> sibling below the SVG, not an overlay, so it never
		// collides with axis labels. Each item: a <span> with an <i> colour swatch.
		function drawLegend(state, labelsOverride) {
			const cfg = state.config;
			const items = labelsOverride || cfg.series.map(s => s.name).filter(Boolean);
			if (!items.length) return;
			const footer = document.createElement('footer');
			items.forEach((label, i) => {
				const item = document.createElement('span');
				const sw = document.createElement('i');
				sw.style.setProperty('--color-chart-color', seriesColorVar(i, cfg.series[i] && cfg.series[i].color));
				const tx = document.createElement('span');
				tx.textContent = label; // untrusted-safe
				item.append(sw, tx); footer.appendChild(item);
			});
			state.el.appendChild(footer);
		}

		/* ---- Register directive + magic ----------------------------- */
		Alpine.directive('chart', (el, { modifiers, expression }, { cleanup }) => {
			if (el._chartState) return;
			const state = createState(el, expression, modifiers);
			el._chartState = state;
			el.classList.add('chart');
			// Reserve height up front (config, default 240): a 0-height box doesn't
			// reliably trigger the lazy-load observer, and reserving avoids a layout jump.
			const hm = expression && /height\s*:\s*(\d+)/.exec(expression);
			el.style.minHeight = (hm ? +hm[1] : 240) + 'px';
			observer().observe(el);
			cleanup(() => {
				if (state._ro) state._ro.disconnect();
				if (state._onLocale) window.removeEventListener('localechange', state._onLocale);
				if (io) io.unobserve(el);
				if (el.id) delete _registry[el.id];
				delete el._chartState;
			});
		});

		Alpine.magic('chart', (el) => {
			const local = findAncestorState(el);
			const byId = (id) => { if (!id) return local ? local.api : _nullApi; return _registry[id] || _nullApi; };
			return new Proxy(byId, { get(fn, prop) { if (local && local.api && prop in local.api) return local.api[prop]; return fn[prop]; } });
		});
	}

	/* ---- Bootstrap shim (loader contract) --------------------------- */
	let chartsPluginInitialized = false;
	let chartsAlpineHasWalked = false;
	document.addEventListener('alpine:initialized', () => { chartsAlpineHasWalked = true; });

	function ensureChartsPluginInitialized() {
		if (chartsPluginInitialized) return;
		if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
		chartsPluginInitialized = true;
		initializeChartsPlugin();
		if (chartsAlpineHasWalked && typeof window.Alpine.initTree === 'function') {
			document.querySelectorAll('[x-chart]').forEach(el => { if (!el.__x) window.Alpine.initTree(el); });
		}
	}
	window.ensureChartsPluginInitialized = ensureChartsPluginInitialized;

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureChartsPluginInitialized);
	document.addEventListener('alpine:init', ensureChartsPluginInitialized);
	if (window.Alpine && typeof window.Alpine.directive === 'function') setTimeout(ensureChartsPluginInitialized, 0);
	else {
		const check = setInterval(() => { if (window.Alpine?.directive) { clearInterval(check); ensureChartsPluginInitialized(); } }, 10);
		setTimeout(() => clearInterval(check), 5000);
	}
})();
