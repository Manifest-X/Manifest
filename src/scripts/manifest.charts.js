/*  Manifest Charts
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  An in-house SVG chart renderer. SVG (not canvas) so charts inherit theme
/*  colors via CSS variables, are restylable with the same selector
/*  conventions as every other element, survive static prerendering as real
/*  DOM, and expose accessible <title>/<desc>. The only dependencies are the
/*  d3-scale / d3-shape / d3-array micro-modules (ISC, ~22KB), lazy-loaded
/*  from esm.run on first scroll-into-view — the same posture as the code
/*  plugin loading highlight.js on demand.
*/

(function () {
	'use strict';

	/* ------------------------------------------------------------------ *
	 * Shared global: ManifestUI (universal `_ui` resolver). Defined guarded so
	 * charts works whether or not the date picker (which also defines it) is
	 * loaded. `_ui` is a reserved, self-identifying key: any loaded data source
	 * may carry a top-level `_ui` object, namespaced per element (`_ui.charts`,
	 * `_ui.colorpicker`, …); no manifest flag — overrides piggyback on the normal
	 * local-data/localization model. resolve() deep-merges every loaded source's
	 * `_ui[component]` onto the plugin's English fallbacks. Kept byte-identical
	 * across the date picker / color picker copies.
	 * ------------------------------------------------------------------ */
	if (!window.ManifestUI) {
		window.ManifestUI = {
			/* Names of data sources that have loaded (current locale). Enumerates loaded
			 * sources only — never force-loads others just to scan them for `_ui`. */
			_loadedSourceNames() {
				try {
					const store = window.ManifestDataStore && window.ManifestDataStore.rawDataStore;
					if (store && typeof store.keys === 'function') return [...store.keys()];
				} catch (_) { }
				return [];
			},
			/* Deep-merge every loaded source's `_ui[component]` onto `fallbacks`.
			 * Reads inside the caller's Alpine effect (if any) so $x/$locale make it reactive. */
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

			// Series may be omitted in favor of a single `data` array.
			if (!cfg.series && cfg.data) cfg.series = [{ name: cfg.name || '', data: cfg.data }];
			if (!Array.isArray(cfg.series)) cfg.series = [];

			// Pie/donut: accept [{label,value}] in data.
			if ((cfg.type === 'pie' || cfg.type === 'donut') && cfg.series.length) {
				const s = cfg.series[0];
				if (Array.isArray(s.data) && s.data.length && typeof s.data[0] === 'object') {
					cfg.labels = s.data.map(d => d.label);
					s.data = s.data.map(d => num(d.value, 0));
				}
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
		// Entry animations run only on a chart's first draw. Reactive redraws
		// (a bound value changing, a resize) must paint the final state directly
		// — otherwise dragging a slider replays the reveal every frame and the
		// chart flickers. drawChart sets this before dispatching.
		let _suppressAnim = false;
		function animate(el, keyframes, opts) {
			if (_suppressAnim || prefersReducedMotion() || typeof el.animate !== 'function') return;
			try { el.animate(keyframes, Object.assign({ duration: 600, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'backwards' }, opts)); } catch (_) { }
		}
		// Cursor-following tooltip. Manifest's x-tooltip relies on CSS anchor
		// positioning, which can't anchor to SVG child elements (no CSS-layout
		// box) — so charts use their own tip, themed to match, following the
		// pointer (better UX for dense charts). aria-label carries AT semantics.
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

				// Coalesce to one draw per tick. Uses setTimeout (not rAF) so draws
				// still happen when the tab is backgrounded (rAF is paused for hidden
				// tabs), and does NOT reset a pending timer on re-entry — a
				// high-frequency reactive trigger (e.g. a plugin bumping the data-store
				// version every tick) would otherwise perpetually reschedule and starve
				// the draw.
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
			const height = cfg.height;

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
			else drawCartesian(state, root, width, height);
		}

		// Palette size is CSS-driven: count consecutive --color-chart-N custom
		// properties (themes can extend past 8 by defining --color-chart-9, …);
		// segment colours cycle through however many exist. Re-probed per draw
		// so per-scope overrides apply.
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

		// Gauge — a single value swept across a 180° dome. Track + value arc
		// reuse the pie/donut arc primitive; optional `zones` paint threshold
		// bands (e.g. positive/warning/negative ranges). `unit` suffixes the
		// centered readout; `min`/`max` default 0–100.
		function drawGauge(state, root, width, height) {
			const cfg = state.config, d3 = state.d3;
			const value = num(cfg.series[0] && cfg.series[0].data[0], 0);
			const min = cfg.min, max = cfg.max;
			const START = -Math.PI / 2, END = Math.PI / 2;
			const scale = d3.scaleLinear().domain([min, max]).range([START, END]).clamp(true);
			const unit = cfg.unit || '';

			const r = Math.min(width / 2, height) - 8;
			const thickness = Math.max(8, r * 0.22);
			const cx = width / 2, cy = 8 + r;
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

			// Value arc — final geometry is set unconditionally so the gauge is
			// correct even if the entry animation never runs (background tab);
			// the sweep is a CSS reveal, never the source of the end state.
			const color = (cfg.series[0] && cfg.series[0].color) || 'var(--color-chart-1)';
			const valueAngle = scale(value);
			const vArc = svg('path', { class: 'gauge-value', d: arc({ startAngle: START, endAngle: valueAngle }), style: `--color-chart-color:${color}` }, g);
			applyTip(vArc, (cfg.title ? cfg.title + ': ' : '') + value + unit, cfg);
			// Reveal via fade (WAAPI, origin-independent) — the final geometry above
			// is unconditional, so the gauge is correct even if this never runs.
			animate(vArc, [{ opacity: 0 }, { opacity: 1 }], { duration: 500 });

			// Centered readout + range end labels.
			text(g, value + unit, { class: 'gauge-label', x: 0, y: -r * 0.12, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
			if (cfg.axis) {
				const lr = r - thickness / 2;
				text(g, String(min), { x: -lr, y: 16, 'text-anchor': 'middle' });
				text(g, String(max), { x: lr, y: 16, 'text-anchor': 'middle' });
			}
		}

		// Heatmap — a matrix of cells: each series is a row, each datum a column
		// aligned to `labels`. Cell colour is a CSS color-mix between the two
		// --color-chart-heat-* tokens (no JS colour-interpolation dep), driven
		// by the per-cell `--heat` percentage.
		function drawHeatmap(state, root, width, height) {
			const cfg = state.config, d3 = state.d3;
			const rows = cfg.series;
			const cols = cfg.labels.length ? cfg.labels : (rows[0] && Array.isArray(rows[0].data) ? rows[0].data.map((_, i) => i + 1) : []);
			const rowName = (r, i) => r.name || String(i + 1);
			const showLabels = cfg.axis;

			const m = { top: 4, right: 4, bottom: showLabels ? 24 : 4, left: showLabels ? 64 : 4 };
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

			// Round only the grid's outer corners: square tiles clipped to a single
			// rounded rect hugging the cell extent (right/bottom edge sits at the
			// last tile's inner edge, so the radius isn't clipping empty gutter).
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

		// Legend is a <footer> sibling below the SVG (inline flex), not an
		// absolute overlay — so it never collides with axis labels. Each item is
		// a <span> with an <i> swatch carrying the series colour.
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
			// Reserve the chart's height up front (parsed from the config, default
			// 240) so the empty container isn't 0-height — a zero-height box doesn't
			// reliably trigger the lazy-load IntersectionObserver, and reserving it
			// also prevents a layout jump when the SVG renders.
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
