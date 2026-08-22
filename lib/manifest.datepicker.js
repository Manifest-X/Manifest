/*  Manifest Date Picker — modular date/time picker behind one `x-date` directive
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
*/

(function () {
	'use strict';

	/* Shared global: ManifestDates — dependency-free date math, noon-anchored to
	 * dodge DST shifts. Formatting/localization delegated to Intl (never parses
	 * locale strings). */
	if (!window.ManifestDates) {
		const pad = (n) => String(n).padStart(2, '0');
		const D = {
			/* Construct a noon-anchored Date from y/m/d (m is 1-based). */
			make(y, m, d) { return new Date(y, m - 1, d, 12, 0, 0, 0); },
			/* Today, noon-anchored. */
			today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12); },
			/* Serialize to ISO yyyy-mm-dd from LOCAL parts (matches what the user sees). */
			toISO(date) { if (!(date instanceof Date) || isNaN(date)) return ''; return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()); },
			/* Parse an ISO yyyy-mm-dd (or anything Date accepts) to a noon-anchored Date; null on failure. */
			fromISO(str) {
				if (str instanceof Date) return isNaN(str) ? null : new Date(str.getFullYear(), str.getMonth(), str.getDate(), 12);
				if (typeof str !== 'string') return null;
				const m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
				if (m) return D.make(+m[1], +m[2], +m[3]);
				const d = new Date(str);
				return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
			},
			addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; },
			addMonths(date, n) {
				const d = new Date(date);
				const targetMonth = d.getMonth() + n;
				const y = d.getFullYear() + Math.floor(targetMonth / 12);
				const m = ((targetMonth % 12) + 12) % 12;
				const day = Math.min(d.getDate(), D.daysInMonth(y, m + 1));
				return D.make(y, m + 1, day);
			},
			startOfMonth(date) { return D.make(date.getFullYear(), date.getMonth() + 1, 1); },
			daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }, // m is 1-based
			isSameDay(a, b) { return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); },
			compare(a, b) { const x = D.toISO(a), y = D.toISO(b); return x < y ? -1 : x > y ? 1 : 0; },
			clamp(date, min, max) { if (min && D.compare(date, min) < 0) return min; if (max && D.compare(date, max) > 0) return max; return date; },
			/* First day of week for a locale, normalized to 0=Sun..6=Sat. */
			firstDayOfWeek(locale) {
				try {
					const loc = new Intl.Locale(locale);
					const info = (typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo);
					if (info && info.firstDay) return info.firstDay === 7 ? 0 : info.firstDay; // Intl: 1=Mon..7=Sun
				} catch (_) { }
				// Fallback: US-style locales start Sunday, most others Monday.
				return /^en(-US|-CA|-PH)?$/i.test(locale || '') ? 0 : 1;
			}
		};
		window.ManifestDates = D;
	}

	/* Shared global: ManifestUI — `_ui` text resolver. A loaded data source may carry
	 * a top-level `_ui` object namespaced per component (_ui.date, _ui.colorpicker, …);
	 * resolve() deep-merges it onto the plugin's English fallbacks. Locale-reactive via
	 * $x/$locale. Kept byte-identical across the colorpicker / charts copies. */
	if (!window.ManifestUI) {
		window.ManifestUI = {
			/* Loaded data-source names only — never force-loads others to scan them. */
			_loadedSourceNames() {
				try {
					const store = window.ManifestDataStore && window.ManifestDataStore.rawDataStore;
					if (store && typeof store.keys === 'function') return [...store.keys()];
				} catch (_) { }
				return [];
			},
			/* Deep-merge every loaded source's `_ui[component]` onto `fallbacks`. */
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

	/* ================================================================== *
	 * Date picker plugin
	 * ================================================================== */
	function initializeDatepickerPlugin() {
		const Alpine = window.Alpine;
		const D = window.ManifestDates;

		// Reactive registry id -> api, so $date('id') resolves across mount order.
		const _registry = Alpine.reactive ? Alpine.reactive({}) : {};
		let _uid = 0;

		// Default English UI chrome; overridable via a data source's `_ui.date`.
		const UI_FALLBACK = {
			today: 'Today',
			now: 'Now',
			clear: 'Clear',
			previousMonth: 'Previous month',
			nextMonth: 'Next month',
			time: 'Time'
		};

		// A no-op api so bindings never throw before a calendar exists.
		const _nullApi = {
			value: '', iso: '', formatted: '', date: null,
			setDate() { }, clear() { }, open() { }, close() { },
			[Symbol.toPrimitive]() { return ''; }, toString() { return ''; }, valueOf() { return ''; }
		};

		const currentLocale = () => {
			try { return Alpine.store('locale')?.current || document.documentElement.lang || 'en'; } catch (_) { return document.documentElement.lang || 'en'; }
		};

		function findAncestorState(el) {
			let n = el;
			while (n) { if (n._dateState) return n._dateState; n = n.parentElement; }
			return null;
		}

		const pad2 = (n) => String(n).padStart(2, '0');

		// Normalize a firstDay config value to 0=Sun..6=Sat, or null (locale default).
		// Accepts 0–6, or a weekday name ('sunday', 'mon', …).
		const _dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
		function parseFirstDay(v) {
			if (v == null || v === '') return null;
			if (typeof v === 'number' && v >= 0 && v <= 6) return v;
			const s = String(v).toLowerCase().trim();
			const i = _dayNames.findIndex(n => n === s || n.slice(0, 3) === s);
			if (i >= 0) return i;
			const n = parseInt(s, 10);
			return (!isNaN(n) && n >= 0 && n <= 6) ? n : null;
		}

		// Capitalize + strip trailing periods for chrome labels; aria-labels keep raw Intl output.
		function tidy(s, locale) {
			if (!s) return s;
			let out = s.replace(/\.+$/, '');
			try { out = out.charAt(0).toLocaleUpperCase(locale) + out.slice(1); }
			catch (_) { out = out.charAt(0).toUpperCase() + out.slice(1); }
			return out;
		}

		// 12-hour clock locales (en-US etc.) get an AM/PM segment.
		function uses12h(locale) {
			try { return !!new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12; }
			catch (_) { return false; }
		}

		/* ---- Per-calendar state ------------------------------------- */
		function createState(rootEl) {
			const today = D.today();
			const now = new Date();
			const state = {
				rootEl,
				id: rootEl.id || ('mnfst-dp-' + (++_uid)),
				selectionMode: 'single',   // 'single' | 'range' | 'multiple'
				selected: null,            // Date | null  (single)
				rangeStart: null, rangeEnd: null, rangeHover: null, // range
				selectedDates: [],         // Date[] (multiple)
				view: { y: today.getFullYear(), m: today.getMonth() + 1 },
				viewMode: 'days',          // 'days' | 'months' | 'years'
				monthCount: 1,             // months shown side by side (two-up = 2)
				firstDay: null,            // 0=Sun..6=Sat override; null = locale default
				presets: [],               // [{ label, value | start+end | dates[] }]
				withTime: false,           // append a time-of-day control (single mode)
				timeOnly: false,           // standalone time picker (input type="time")
				time: pad2(now.getHours()) + ':' + pad2(now.getMinutes()),
				timeSet: false,            // time becomes part of the value once touched/seeded
				showNow: true,             // Now / Today action (config: now:false)
				showClear: true,           // Clear action (config: clear:false)
				min: null, max: null,
				disabled: [],              // ISO strings, {from,to} ranges, or a predicate fn
				format: null,              // trigger display format (see formatValue)
				mode: 'inline',            // 'inline' (authored container) | 'menu' (plugin-owned dropdown)
				field: null,               // trigger element, if any
				fieldPlaceholder: '',      // captured initial label/placeholder text
				hiddenInput: null,
				modelGet: null, modelSet: null,
				snapshot: Alpine.reactive ? Alpine.reactive({ version: 0 }) : { version: 0 },
				_mounted: false,

				bump() { this.snapshot.version++; },
				locale() { return currentLocale(); },

				isDisabled(date) {
					if (this.min && D.compare(date, this.min) < 0) return true;
					if (this.max && D.compare(date, this.max) > 0) return true;
					const dis = this.disabled;
					if (typeof dis === 'function') { try { return !!dis(date); } catch (_) { return false; } }
					if (Array.isArray(dis)) {
						const iso = D.toISO(date);
						return dis.some(d => {
							if (typeof d === 'string') return d === iso;
							if (d && d.from && d.to) return iso >= d.from && iso <= d.to;
							return false;
						});
					}
					return false;
				},

				// Trigger display text. `format` (config/attr) overrides the default
				// localized medium style: a dateStyle keyword ('short'|'medium'|
				// 'long'|'full'), an Intl.DateTimeFormat options object, 'iso',
				// 'relative', or a (date) => string function. The emitted/model
				// value stays ISO regardless — this only restyles the visible text.
				formatValue(date) {
					if (!date) return '';
					const f = this.format, loc = this.locale();
					try {
						if (typeof f === 'function') return String(f(date));
						if (f === 'iso') return D.toISO(date);
						if (f === 'relative') {
							const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
							const b = new Date(); b.setHours(0, 0, 0, 0);
							const days = Math.round((a - b) / 86400000), abs = Math.abs(days);
							const rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
							if (abs < 7) return rtf.format(days, 'day');
							if (abs < 30) return rtf.format(Math.round(days / 7), 'week');
							if (abs < 365) return rtf.format(Math.round(days / 30), 'month');
							return rtf.format(Math.round(days / 365), 'year');
						}
						if (f && typeof f === 'object') return new Intl.DateTimeFormat(loc, f).format(date);
						if (typeof f === 'string') return new Intl.DateTimeFormat(loc, { dateStyle: f }).format(date);
						return new Intl.DateTimeFormat(loc, { dateStyle: 'medium' }).format(date);
					} catch (_) {
						try { return new Intl.DateTimeFormat(loc, { dateStyle: 'medium' }).format(date); }
						catch (_) { return D.toISO(date); }
					}
				},

				formatTime() {
					try {
						const [h, mi] = this.time.split(':').map(Number);
						const dt = new Date(2000, 0, 1, h || 0, mi || 0);
						return new Intl.DateTimeFormat(this.locale(), { timeStyle: 'short' }).format(dt);
					} catch (_) { return this.time; }
				},

				// Human-readable display for the field / trigger label.
				displayValue() {
					if (this.timeOnly) return this.timeSet ? this.formatTime() : '';
					if (this.selectionMode === 'range') {
						if (this.rangeStart && this.rangeEnd) return this.formatValue(this.rangeStart) + ' – ' + this.formatValue(this.rangeEnd);
						if (this.rangeStart) return this.formatValue(this.rangeStart) + ' – …';
						return '';
					}
					if (this.selectionMode === 'multiple') {
						if (!this.selectedDates.length) return '';
						if (this.selectedDates.length === 1) return this.formatValue(this.selectedDates[0]);
						return this.selectedDates.length + ' dates';
					}
					if (this.withTime && this.selected) {
						if (this.format) return this.formatValue(this.selected) + ' ' + this.formatTime();
						try {
							const [h, mi] = this.time.split(':').map(Number);
							const dt = new Date(this.selected.getFullYear(), this.selected.getMonth(), this.selected.getDate(), h || 0, mi || 0);
							return new Intl.DateTimeFormat(this.locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(dt);
						} catch (_) { return D.toISO(this.selected) + ' ' + this.time; }
					}
					return this.formatValue(this.selected);
				},

				// The committed-or-previewing range, normalized start ≤ end.
				activeRange() {
					if (this.selectionMode !== 'range') return null;
					let s = this.rangeStart, e = this.rangeEnd;
					if (s && !e && this.rangeHover) e = this.rangeHover;
					if (s && e && D.compare(e, s) < 0) { const t = s; s = e; e = t; }
					return { start: s, end: e };
				},

				// (Re)apply selection/today to a day button — ARIA for selection/today,
				// plain classes for range shape (no ARIA equivalent).
				applyDayState(btn, date) {
					btn.classList.remove('range-start', 'range-end', 'in-range');
					btn.removeAttribute('aria-selected');
					if (D.isSameDay(date, D.today())) btn.setAttribute('aria-current', 'date'); else btn.removeAttribute('aria-current');
					if (this.selectionMode === 'range') {
						const r = this.activeRange();
						if (r && r.start && D.isSameDay(date, r.start)) { btn.classList.add('range-start'); btn.setAttribute('aria-selected', 'true'); }
						if (r && r.end && D.isSameDay(date, r.end)) { btn.classList.add('range-end'); btn.setAttribute('aria-selected', 'true'); }
						if (r && r.start && r.end && D.compare(date, r.start) > 0 && D.compare(date, r.end) < 0) btn.classList.add('in-range');
					} else if (this.selectionMode === 'multiple') {
						if (this.selectedDates.some(d => D.isSameDay(d, date))) btn.setAttribute('aria-selected', 'true');
					} else if (this.selected && D.isSameDay(date, this.selected)) {
						btn.setAttribute('aria-selected', 'true');
					}
				},

				// Repaint range highlight without rebuilding the grid (used on hover).
				paintRange() {
					this.rootEl.querySelectorAll('[role=grid] button').forEach(btn => {
						const d = D.fromISO(btn.value);
						if (d) this.applyDayState(btn, d);
					});
				},

				select(date) {
					if (!date || this.isDisabled(date)) return;
					// Jump the view only when the picked date is outside the visible month window.
					const count = Math.max(1, this.monthCount || 1);
					const idx = (date.getFullYear() * 12 + date.getMonth()) - (this.view.y * 12 + (this.view.m - 1));
					if (idx < 0 || idx >= count) this.view = { y: date.getFullYear(), m: date.getMonth() + 1 };
					if (this.selectionMode === 'range') {
						if (!this.rangeStart || (this.rangeStart && this.rangeEnd)) {
							this.rangeStart = date; this.rangeEnd = null; this.rangeHover = null;
						} else {
							let s = this.rangeStart, e = date;
							if (D.compare(e, s) < 0) { const t = s; s = e; e = t; }
							this.rangeStart = s; this.rangeEnd = e; this.rangeHover = null;
						}
						this.syncOut(); this.bump(); this.render();
						if (this.rangeEnd && this.mode === 'menu') this.close();
						return;
					}
					if (this.selectionMode === 'multiple') {
						const iso = D.toISO(date);
						const idx = this.selectedDates.findIndex(d => D.toISO(d) === iso);
						if (idx >= 0) this.selectedDates.splice(idx, 1);
						else { this.selectedDates.push(date); this.selectedDates.sort((a, b) => D.compare(a, b)); }
						this.syncOut(); this.bump(); this.render();
						return; // stay open for multi-select
					}
					this.selected = date;
					if (this.withTime) this.timeSet = true;
					this.syncOut(); this.bump(); this.render();
					// With a time control, stay open so the user can set the time.
					if (this.mode === 'menu' && !this.withTime) this.close();
				},

				setTime(h24, mi) {
					this.time = pad2(h24) + ':' + pad2(mi);
					this.timeSet = true;
					this.syncOut(); this.bump();
				},

				clear() {
					this.selected = null; this.rangeStart = null; this.rangeEnd = null; this.rangeHover = null; this.selectedDates = [];
					this.timeSet = false;
					this.syncOut(); this.bump(); this.render();
				},

				_primaryValue() {
					if (this.timeOnly) return this.timeSet ? this.time : '';
					if (this.selectionMode === 'range') { const s = this.rangeStart ? D.toISO(this.rangeStart) : '', e = this.rangeEnd ? D.toISO(this.rangeEnd) : ''; return s && e ? s + '/' + e : s; }
					if (this.selectionMode === 'multiple') return this.selectedDates.map(d => D.toISO(d)).join(',');
					if (!this.selected) return '';
					const iso = D.toISO(this.selected);
					return this.withTime ? iso + 'T' + this.time : iso;
				},

				setView(y, m) {
					const dt = D.make(y, m, 1); // normalize month overflow
					this.view = { y: dt.getFullYear(), m: dt.getMonth() + 1 };
					this.render();
				},

				// Write the value out to: x-model, hidden input, and the field display.
				// Model shape: single → ISO string ('yyyy-mm-dd' or '…THH:mm');
				// range → { start, end }; multiple → ISO[]; time-only → 'HH:mm'.
				syncOut() {
					let modelVal, hiddenVal;
					if (this.selectionMode === 'range') {
						const s = this.rangeStart ? D.toISO(this.rangeStart) : '', e = this.rangeEnd ? D.toISO(this.rangeEnd) : '';
						modelVal = { start: s, end: e };
						hiddenVal = s && e ? s + '/' + e : s;
					} else if (this.selectionMode === 'multiple') {
						const arr = this.selectedDates.map(d => D.toISO(d));
						modelVal = arr; hiddenVal = arr.join(',');
					} else {
						const iso = this._primaryValue();
						modelVal = iso; hiddenVal = iso;
					}
					if (this.modelSet) { try { this.modelSet(modelVal); } catch (_) { } }
					if (this.hiddenInput) {
						this.hiddenInput.value = hiddenVal;
						this.hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
						this.hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
					}
					const disp = this.displayValue();
					if (this.field && this.field.tagName === 'INPUT' && this.field.type !== 'hidden') {
						this.field.value = disp;
						// Re-assert the display after x-model writes the raw value back this flush.
						if (this.field.hasAttribute('x-model')) {
							const f = this.field;
							setTimeout(() => { f.value = this.displayValue(); }, 0);
						}
					} else if (this.field && !this.field.firstElementChild) {
						// Text-only triggers swap their text; triggers with element children own theirs.
						this.field.textContent = disp || this.fieldPlaceholder;
					}
				},

				// Pull an initial value from x-model, then hidden input, then value attr.
				seed() {
					let raw;
					if (this.modelGet) { try { raw = this.modelGet(); } catch (_) { } }
					const attrVal = () => this.rootEl.getAttribute('value') || (this.field && this.field.getAttribute && this.field.getAttribute('value')) || '';
					if (this.timeOnly) {
						const str = (typeof raw === 'string' && raw) || (this.hiddenInput && this.hiddenInput.value) || attrVal();
						const m = typeof str === 'string' && str.match(/^(\d{2}):(\d{2})/);
						if (m) { this.time = m[1] + ':' + m[2]; this.timeSet = true; }
					} else if (this.selectionMode === 'range') {
						let s, e;
						if (raw && typeof raw === 'object' && !(raw instanceof Date)) { s = raw.start; e = raw.end; }
						else { const str = (typeof raw === 'string' && raw) || (this.hiddenInput && this.hiddenInput.value) || attrVal(); if (str.includes('/')) { const p = str.split('/'); s = p[0]; e = p[1]; } else s = str; }
						this.rangeStart = s ? D.fromISO(s) : null; this.rangeEnd = e ? D.fromISO(e) : null;
						if (this.rangeStart) this.view = { y: this.rangeStart.getFullYear(), m: this.rangeStart.getMonth() + 1 };
					} else if (this.selectionMode === 'multiple') {
						let arr = [];
						if (Array.isArray(raw)) arr = raw;
						else { const str = (typeof raw === 'string' && raw) || (this.hiddenInput && this.hiddenInput.value) || attrVal(); if (str) arr = str.split(','); }
						this.selectedDates = arr.map(x => D.fromISO(x)).filter(Boolean).sort((a, b) => D.compare(a, b));
						if (this.selectedDates.length) this.view = { y: this.selectedDates[0].getFullYear(), m: this.selectedDates[0].getMonth() + 1 };
					} else {
						let iso = '';
						if (typeof raw === 'string' && raw) iso = raw; else if (raw instanceof Date) iso = D.toISO(raw);
						if (!iso && this.hiddenInput && this.hiddenInput.value) iso = this.hiddenInput.value;
						if (!iso) iso = attrVal();
						// Split a datetime seed (yyyy-mm-ddTHH:mm) into date + time.
						const tm = typeof iso === 'string' && iso.match(/T(\d{2}:\d{2})/);
						if (tm) { this.time = tm[1]; this.withTime = true; this.timeSet = true; }
						const d = iso ? D.fromISO(iso) : null;
						if (d) { this.selected = d; this.view = { y: d.getFullYear(), m: d.getMonth() + 1 }; }
					}
				},

				// Only the plugin-generated dropdown opens here; native showPopover() rides
				// the reset.css/dropdown.css popover wiring. Authored calendars are inline.
				open() {
					if (this.mode !== 'menu') return;
					this.viewMode = 'days';
					const t = this.rootEl;
					if (t.matches(':popover-open')) { this.close(); return; } // toggle
					this.render();
					// Body-appended, so neither the popover tree nor manifest.dialog.css can see
					// that this calendar belongs to the field's dialog or menu. `source` names the
					// invoker (a text input can't carry popovertarget), without which opening the
					// calendar light-dismisses the very thing it was opened from; the attribute
					// exempts it from the stray-dropdown rule that would otherwise fade it out.
					t.toggleAttribute('data-popover-nested', !!(this.field && this.field.closest('[popover]')));
					try { t.showPopover({ source: this.field }); } catch (_) { }
				},
				close() {
					if (this._closeTimeMenu) this._closeTimeMenu();
					if (this.mode !== 'menu') return;
					const t = this.rootEl;
					try { if (t.matches(':popover-open')) t.hidePopover(); } catch (_) { }
				},

				render() { renderCalendar(this); },

				get api() {
					const self = this;
					return {
						get value() { self.snapshot.version; return self._primaryValue(); },
						get iso() { self.snapshot.version; return self._primaryValue(); },
						get formatted() { self.snapshot.version; return self.displayValue(); },
						get date() { self.snapshot.version; return self.selected; },
						get range() { self.snapshot.version; return { start: self.rangeStart ? D.toISO(self.rangeStart) : '', end: self.rangeEnd ? D.toISO(self.rangeEnd) : '' }; },
						get start() { self.snapshot.version; return self.rangeStart ? D.toISO(self.rangeStart) : ''; },
						get end() { self.snapshot.version; return self.rangeEnd ? D.toISO(self.rangeEnd) : ''; },
						get dates() { self.snapshot.version; return self.selectedDates.map(d => D.toISO(d)); },
						get time() { self.snapshot.version; return self.timeSet ? self.time : ''; },
						get mode() { return self.selectionMode; },
						setDate(v) { const d = D.fromISO(v); if (d) self.select(d); },
						setTime(v) { const m = String(v || '').match(/^(\d{1,2}):(\d{2})/); if (m) self.setTime(+m[1], +m[2]); },
						clear() { self.clear(); },
						open() { self.open(); },
						close() { self.close(); },
						[Symbol.toPrimitive]() { self.snapshot.version; return self._primaryValue(); },
						toString() { self.snapshot.version; return self._primaryValue(); },
						valueOf() { self.snapshot.version; return self._primaryValue(); }
					};
				}
			};
			// Styling marker: CSS can't match attribute-NAME prefixes, so modified
			// attributes (x-date.range, …) are unreachable by [x-date] selectors.
			rootEl.classList.add('date-picker');
			return state;
		}

		/* ---- Calendar rendering ------------------------------------- */
		// Chevrons are CSS mask icons (see manifest.datepicker.css) — no markup,
		// no icons-plugin dependency.
		function navButton(aria, onClick) {
			const b = document.createElement('button');
			b.type = 'button';
			b.setAttribute('aria-label', aria);
			b.addEventListener('click', onClick);
			return b;
		}
		// <header> — previous / heading / next.
		function buildHeader(shell, labelText, onPrev, onNext, onLabel, ui) {
			const header = document.createElement('header');
			const label = document.createElement('button');
			label.type = 'button'; label.setAttribute('aria-live', 'polite');
			label.textContent = labelText;
			if (onLabel) label.addEventListener('click', onLabel); else label.disabled = true;
			header.append(
				navButton(ui.previousMonth, onPrev),
				label,
				navButton(ui.nextMonth, onNext)
			);
			shell.appendChild(header);
		}

		function renderCalendar(state) {
			const root = state.rootEl;
			const locale = state.locale();
			const ui = window.ManifestUI.resolve('date', UI_FALLBACK);

			// Reuse or build the shell once.
			let shell = root.querySelector(':scope > [role=group]');
			if (!shell) {
				shell = document.createElement('div');
				shell.setAttribute('role', 'group');
				root.appendChild(shell);
			}
			shell.innerHTML = '';

			if (state.timeOnly) {
				renderTime(state, shell, locale, ui);
			} else if (state.viewMode === 'months') renderMonthsView(state, shell, locale, ui);
			else if (state.viewMode === 'years') renderYearsView(state, shell, locale, ui);
			else {
				renderDaysView(state, shell, locale, ui);
				if (state.withTime && state.selectionMode === 'single') renderTime(state, shell, locale, ui);
			}
			const onDays = !state.timeOnly && state.viewMode === 'days';

			// <footer> — Today | presets | Clear. Standalone time keeps Now/Clear
			// in its inline columns, so it has no footer.
			if (!state.timeOnly && (state.showNow || state.showClear || (onDays && Array.isArray(state.presets) && state.presets.length))) {
				const footer = document.createElement('footer');
				if (state.showNow) {
					const todayBtn = document.createElement('button');
					todayBtn.type = 'button'; todayBtn.className = 'sm ghost';
					todayBtn.textContent = ui.today;
					todayBtn.addEventListener('click', () => { state.viewMode = 'days'; state.select(D.clamp(D.today(), state.min, state.max)); });
					footer.append(todayBtn);
				}
				if (onDays && Array.isArray(state.presets) && state.presets.length) footer.appendChild(buildPresets(state));
				if (state.showClear) {
					const clearBtn = document.createElement('button');
					clearBtn.type = 'button'; clearBtn.className = 'sm ghost'; clearBtn.textContent = ui.clear;
					clearBtn.addEventListener('click', () => state.clear());
					footer.append(clearBtn);
				}
				shell.appendChild(footer);
			}

		}

		function renderDaysView(state, shell, locale, ui) {
			const { y, m } = state.view;
			const count = Math.max(1, Math.min(4, state.monthCount || 1));
			const today = D.today();
			const firstDOW = state.firstDay != null ? state.firstDay : D.firstDayOfWeek(locale);
			let fMonthYear, fMonth, wdFmt, dayFmt;
			try { fMonthYear = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }); } catch (_) { }
			try { fMonth = new Intl.DateTimeFormat(locale, { month: 'long' }); } catch (_) { }
			try { wdFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' }); } catch (_) { }
			try { dayFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'full' }); } catch (_) { }

			// Header label: "June 2026", or "June – August 2026" when multi-month.
			let label;
			const first = D.make(y, m, 1);
			const last = D.addMonths(first, count - 1);
			if (fMonthYear) {
				label = count === 1 ? tidy(fMonthYear.format(first), locale)
					: tidy(last.getFullYear() === y && fMonth ? fMonth.format(first) : fMonthYear.format(first), locale) + ' – ' + tidy(fMonthYear.format(last), locale);
			} else label = y + '-' + m;
			buildHeader(shell, label,
				() => state.setView(y, m - 1),
				() => state.setView(y, m + 1),
				() => { state.viewMode = 'months'; state.render(); }, ui);

			// One <section> per visible month, side by side. Weekday <abbr> labels
			// share the 7-column grid with the day buttons, so they always align.
			const monthsWrap = document.createElement('div');
			for (let k = 0; k < count; k++) {
				const base = D.addMonths(first, k);
				const yy = base.getFullYear(), mm = base.getMonth() + 1;
				const block = document.createElement('section');

				if (count > 1 && fMonth) {
					const sub = document.createElement('small');
					sub.textContent = tidy(fMonth.format(base), locale);
					block.appendChild(sub);
				}

				const grid = document.createElement('div');
				grid.setAttribute('role', 'grid');
				for (let i = 0; i < 7; i++) {
					const dow = (firstDOW + i) % 7;
					const ref = D.make(2024, 9, 1 + dow); // 2024-09-01 is a Sunday
					const cell = document.createElement('abbr');
					cell.setAttribute('aria-hidden', 'true');
					cell.textContent = wdFmt ? tidy(wdFmt.format(ref), locale) : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][dow];
					grid.appendChild(cell);
				}
				const lead = (base.getDay() - firstDOW + 7) % 7;
				const gridStart = D.addDays(base, -lead);
				for (let i = 0; i < 42; i++) {
					const date = D.addDays(gridStart, i);
					const inMonth = date.getMonth() === (mm - 1);
					const btn = document.createElement('button');
					btn.type = 'button';
					if (!inMonth) btn.classList.add('outside');
					btn.setAttribute('role', 'gridcell');
					btn.value = D.toISO(date);
					btn.setAttribute('tabindex', '-1');
					btn.textContent = String(date.getDate());
					if (dayFmt) btn.setAttribute('aria-label', dayFmt.format(date));
					state.applyDayState(btn, date);
					if (state.isDisabled(date)) btn.disabled = true;
					btn.addEventListener('click', () => state.select(date));
					if (state.selectionMode === 'range') {
						btn.addEventListener('mouseenter', () => { if (state.rangeStart && !state.rangeEnd) { state.rangeHover = date; state.paintRange(); } });
					}
					grid.appendChild(btn);
				}
				block.appendChild(grid);
				monthsWrap.appendChild(block);
			}

			// Roving tabindex: the primary selection (or today) is the single tab
			// stop; prefer the in-month cell when the date appears twice (a month's
			// trailing days repeat as the next month's leading `outside` cells).
			const focusISO = state.selectionMode === 'range' ? (state.rangeStart && D.toISO(state.rangeStart))
				: state.selectionMode === 'multiple' ? (state.selectedDates[0] && D.toISO(state.selectedDates[0]))
					: (state.selected && D.toISO(state.selected));
			const sel = 'button[value="' + (focusISO || D.toISO(today)) + '"]:not([disabled])';
			const focusBtn = monthsWrap.querySelector(sel + ':not(.outside)') || monthsWrap.querySelector(sel) || monthsWrap.querySelector('[role=grid] button:not([disabled])');
			if (focusBtn) focusBtn.setAttribute('tabindex', '0');
			if (state.selectionMode === 'range') {
				monthsWrap.addEventListener('mouseleave', () => { if (state.rangeStart && !state.rangeEnd) { state.rangeHover = null; state.paintRange(); } });
			}
			monthsWrap.addEventListener('keydown', (e) => handleGridKeys(e, state));
			shell.appendChild(monthsWrap);
		}

		/* ---- Presets ------------------------------------------------- */
		// Presets never close the menu — the selection updates in place so the
		// author can refine it or pick another pill.
		function applyPreset(state, p) {
			if (!p || typeof p !== 'object') return;
			if (state.selectionMode === 'range') {
				const s = p.start ? D.fromISO(p.start) : (p.value ? D.fromISO(p.value) : null);
				const e = p.end ? D.fromISO(p.end) : s;
				if (!s) return;
				state.rangeStart = s; state.rangeEnd = e; state.rangeHover = null;
				state.view = { y: s.getFullYear(), m: s.getMonth() + 1 };
				state.syncOut(); state.bump(); state.render();
			} else if (state.selectionMode === 'multiple') {
				const arr = Array.isArray(p.dates) ? p.dates : (p.value ? [p.value] : []);
				state.selectedDates = arr.map(x => D.fromISO(x)).filter(Boolean).sort((a, b) => D.compare(a, b));
				if (state.selectedDates.length) state.view = { y: state.selectedDates[0].getFullYear(), m: state.selectedDates[0].getMonth() + 1 };
				state.syncOut(); state.bump(); state.render();
			} else {
				const d = D.fromISO(p.value || p.start);
				if (!d) return;
				state.selected = d;
				if (state.withTime) state.timeSet = true;
				state.view = { y: d.getFullYear(), m: d.getMonth() + 1 };
				state.syncOut(); state.bump(); state.render();
			}
		}

		// Preset chips, returned for placement in the footer (centered between
		// Today and Clear) so they don't add an extra row.
		function buildPresets(state) {
			const wrap = document.createElement('div');
			state.presets.forEach(p => {
				const btn = document.createElement('button');
				btn.type = 'button';
				// `.unstyle` keeps the shared menu-item / button base styles (which
				// would force full width) off the chip — only the chip rule applies.
				btn.className = 'unstyle';
				btn.textContent = (p && p.label) || ''; // untrusted-safe
				btn.addEventListener('click', () => applyPreset(state, p));
				wrap.appendChild(btn);
			});
			return wrap;
		}

		/* ---- Time of day — no native time input (unstylable). Standalone: columns
		 * render inline in the dropdown. Date+time: typed segments + a body-appended
		 * columns menu (nested under an in-calendar invoker). setTime avoids a full
		 * re-render to keep segment focus. */
		function renderTime(state, shell, locale, ui) {
			const h12 = uses12h(locale);
			const cur = () => { const [h, mi] = state.time.split(':').map(Number); return { h: h || 0, mi: mi || 0 }; };
			const dispH = (h24) => h12 ? (((h24 % 12) || 12)) : h24;

			let segs = null;      // { hIn, mIn, apBtn } when date+time
			let colsRefs = null;  // { h, m, ap } column elements

			// Selectable options carry their text in `value` (hours, minutes,
			// AM/PM); actions (Now/Clear) don't — CSS and refresh() key off it.
			function mkOpt(text, isValue) {
				const b = document.createElement('button');
				b.type = 'button';
				b.textContent = text;
				if (isValue) b.value = text;
				b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus
				return b;
			}
			function mkCol() { return document.createElement('div'); }

			// Builds the hour/minute/(AM-PM) columns into `host` — a `.time-options`
			// wrapper: the popover <menu> (date+time) or an inline <div> (standalone).
			// `withActions` adds Now/Clear (standalone only).
			function buildColumns(host, withActions) {
				host.classList.add('time-options');
				const colH = mkCol(), colM = mkCol();
				const hourVals = h12 ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : Array.from({ length: 24 }, (_, i) => i);
				hourVals.forEach(hv => {
					const b = mkOpt(pad2(hv), true);
					b.addEventListener('click', () => { const c = cur(); let h24 = hv; if (h12) { const pm = c.h >= 12; h24 = (hv % 12) + (pm ? 12 : 0); } state.setTime(h24, c.mi); refresh(); });
					colH.appendChild(b);
				});
				for (let mv = 0; mv < 60; mv += 5) {
					const b = mkOpt(pad2(mv), true);
					b.addEventListener('click', () => { const c = cur(); state.setTime(c.h, mv); refresh(); });
					colM.appendChild(b);
				}
				host.append(colH, colM);
				let colAp = null;
				if (h12) {
					colAp = mkCol();
					['AM', 'PM'].forEach(ap => {
						const b = mkOpt(ap, true);
						b.addEventListener('click', () => { const c = cur(); const base = c.h % 12; state.setTime(ap === 'PM' ? base + 12 : base, c.mi); refresh(); });
						colAp.appendChild(b);
					});
					host.appendChild(colAp);
				}
				if (withActions && (state.showNow || state.showClear)) {
					const actions = colAp || mkCol();
					if (!colAp) host.appendChild(actions);
					if (state.showNow) { const b = mkOpt(ui.now, false); b.addEventListener('click', () => { const n = new Date(); state.setTime(n.getHours(), n.getMinutes()); refresh(); }); actions.appendChild(b); }
					if (state.showClear) { const b = mkOpt(ui.clear, false); b.addEventListener('click', () => { state.clear(); }); actions.appendChild(b); }
				}
				colsRefs = { h: colH, m: colM, ap: colAp };
				return host;
			}

			// Sync segments + column highlights from state.
			function refresh() {
				const c = cur();
				if (segs) {
					if (document.activeElement !== segs.hIn) segs.hIn.value = pad2(dispH(c.h));
					if (document.activeElement !== segs.mIn) segs.mIn.value = pad2(c.mi);
					if (segs.apBtn) segs.apBtn.textContent = c.h >= 12 ? 'PM' : 'AM';
				}
				if (colsRefs) {
					// Exact matches only — a hand-typed 5:12 highlights no minute option.
					const mk = (col, val) => { if (!col) return; col.querySelectorAll('button[value]').forEach(b => { if (b.value === val) b.setAttribute('aria-selected', 'true'); else b.removeAttribute('aria-selected'); }); };
					mk(colsRefs.h, pad2(dispH(c.h)));
					mk(colsRefs.m, pad2(c.mi));
					if (colsRefs.ap) mk(colsRefs.ap, c.h >= 12 ? 'PM' : 'AM');
				}
			}

			/* ---- Standalone: columns inline in the dropdown ---- */
			if (state.timeOnly) {
				shell.appendChild(buildColumns(document.createElement('div'), true));
				refresh();
				return;
			}

			/* ---- Date+time: segment field + body-appended columns menu ---- */
			const wrap = document.createElement('fieldset');
			const lab = document.createElement('label'); lab.textContent = ui.time;
			const fieldBox = document.createElement('div'); fieldBox.setAttribute('role', 'group');
			// `.unstyle` opts these controls out of the shared input/button base
			// styles so only the compact time-row rules apply (the datepicker's own
			// selectors still match — the base skips `.unstyle`, the picker doesn't).
			const mkSeg = (aria) => { const i = document.createElement('input'); i.type = 'text'; i.className = 'unstyle'; i.inputMode = 'numeric'; i.maxLength = 2; i.setAttribute('aria-label', aria); return i; };
			const hIn = mkSeg('Hours'), mIn = mkSeg('Minutes');
			const sep = document.createElement('span'); sep.textContent = ':';
			fieldBox.append(hIn, sep, mIn);
			let apBtn = null;
			if (h12) { apBtn = document.createElement('button'); apBtn.type = 'button'; apBtn.className = 'unstyle'; apBtn.setAttribute('aria-label', 'AM or PM'); fieldBox.appendChild(apBtn); }
			segs = { hIn, mIn, apBtn };

			// Columns menu — body-appended popover so the calendar's overflow can't clip it,
			// yet nests under the in-calendar invoker (won't dismiss the calendar). Its owner
			// is always a calendar, never the page, so it is never a stray dropdown for
			// manifest.dialog.css to fade out.
			const menu = buildColumns(document.createElement('menu'), false);
			menu.setAttribute('popover', '');
			menu.setAttribute('data-popover-nested', '');
			menu.id = 'mnfst-dp-time-' + (++_uid);
			if (state._timeMenuEl && state._timeMenuEl.isConnected) state._timeMenuEl.remove();
			document.body.appendChild(menu);
			state._timeMenuEl = menu;

			const trigger = document.createElement('button');
			trigger.type = 'button';
			trigger.className = 'unstyle';
			trigger.id = 'mnfst-dp-time-trigger-' + _uid;
			trigger.setAttribute('popovertarget', menu.id);
			trigger.setAttribute('aria-label', ui.time);
			fieldBox.appendChild(trigger);
			// The "Time" label is an invoker too (htmlFor forwards activation to the button).
			lab.htmlFor = trigger.id;

			const timeAnchor = '--datepicker-time-' + _uid;
			fieldBox.style.setProperty('anchor-name', `${timeAnchor}, var(--co-anchor, --no-anchor)`);
			fieldBox.style.setProperty('--trigger-anchor', timeAnchor);
			menu.style.setProperty('position-anchor', timeAnchor);
			menu.addEventListener('toggle', (e) => { if (e.newState === 'open') refresh(); });
			state._closeTimeMenu = () => { try { if (menu.matches(':popover-open')) menu.hidePopover(); } catch (_) { } };

			function commit() {
				const c = cur();
				let h = parseInt(hIn.value, 10); if (isNaN(h)) h = dispH(c.h);
				let mi = parseInt(mIn.value, 10); if (isNaN(mi)) mi = c.mi;
				mi = Math.max(0, Math.min(59, mi));
				let h24; if (h12) { h = Math.max(1, Math.min(12, h)); const pm = c.h >= 12; h24 = (h % 12) + (pm ? 12 : 0); } else h24 = Math.max(0, Math.min(23, h));
				state.setTime(h24, mi); refresh();
			}
			[hIn, mIn].forEach(inp => {
				inp.addEventListener('focus', () => inp.select());
				inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, ''); if (inp.value.length >= 2) { commit(); if (inp === hIn) mIn.focus(); } });
				inp.addEventListener('change', commit);
				inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); state._closeTimeMenu(); inp.blur(); } else if (e.key === 'Escape') { state._closeTimeMenu(); } });
			});
			if (apBtn) apBtn.addEventListener('click', () => { const c = cur(); state.setTime(c.h >= 12 ? c.h - 12 : c.h + 12, c.mi); refresh(); });

			wrap.append(lab, fieldBox);
			shell.appendChild(wrap);
			refresh();
		}

		function monthOutOfRange(state, y, mo) {
			if (state.min && D.compare(D.make(y, mo, D.daysInMonth(y, mo)), state.min) < 0) return true;
			if (state.max && D.compare(D.make(y, mo, 1), state.max) > 0) return true;
			return false;
		}
		function yearOutOfRange(state, yr) {
			if (state.min && yr < state.min.getFullYear()) return true;
			if (state.max && yr > state.max.getFullYear()) return true;
			return false;
		}

		function renderMonthsView(state, shell, locale, ui) {
			const y = state.view.y;
			buildHeader(shell, String(y),
				() => { state.view = { y: y - 1, m: state.view.m }; state.render(); },
				() => { state.view = { y: y + 1, m: state.view.m }; state.render(); },
				() => { state.viewMode = 'years'; state.render(); }, ui);

			const cells = document.createElement('div');
			cells.setAttribute('role', 'listbox');
			let mFmt; try { mFmt = new Intl.DateTimeFormat(locale, { month: 'short' }); } catch (_) { mFmt = null; }
			const today = D.today();
			for (let mo = 1; mo <= 12; mo++) {
				const btn = document.createElement('button');
				btn.type = 'button'; btn.setAttribute('role', 'option');
				btn.textContent = mFmt ? tidy(mFmt.format(D.make(y, mo, 1)), locale) : String(mo);
				if (y === today.getFullYear() && mo === today.getMonth() + 1) btn.setAttribute('aria-current', 'true');
				if (state.selected && state.selected.getFullYear() === y && state.selected.getMonth() + 1 === mo) btn.setAttribute('aria-selected', 'true');
				if (monthOutOfRange(state, y, mo)) btn.disabled = true;
				btn.addEventListener('click', () => { state.view = { y, m: mo }; state.viewMode = 'days'; state.render(); });
				cells.appendChild(btn);
			}
			shell.appendChild(cells);
		}

		function renderYearsView(state, shell, locale, ui) {
			const y = state.view.y;
			const base = Math.floor(y / 10) * 10; // decade start
			buildHeader(shell, base + '–' + (base + 9),
				() => { state.view = { y: y - 10, m: state.view.m }; state.render(); },
				() => { state.view = { y: y + 10, m: state.view.m }; state.render(); },
				() => { state.viewMode = 'days'; state.render(); }, ui);

			const cells = document.createElement('div');
			cells.setAttribute('role', 'listbox');
			const today = D.today();
			for (let yr = base - 1; yr <= base + 10; yr++) { // 12 cells, leading/trailing greyed
				const btn = document.createElement('button');
				btn.type = 'button'; btn.setAttribute('role', 'option');
				if (yr < base || yr > base + 9) btn.classList.add('outside');
				btn.textContent = String(yr);
				if (yr === today.getFullYear()) btn.setAttribute('aria-current', 'true');
				if (state.selected && state.selected.getFullYear() === yr) btn.setAttribute('aria-selected', 'true');
				if (yearOutOfRange(state, yr)) btn.disabled = true;
				btn.addEventListener('click', () => { state.view = { y: yr, m: state.view.m }; state.viewMode = 'months'; state.render(); });
				cells.appendChild(btn);
			}
			shell.appendChild(cells);
		}

		function handleGridKeys(e, state) {
			const focused = e.target.closest('button[value]');
			if (!focused) return;
			let date = D.fromISO(focused.value);
			let delta = 0;
			switch (e.key) {
				case 'ArrowLeft': delta = -1; break;
				case 'ArrowRight': delta = 1; break;
				case 'ArrowUp': delta = -7; break;
				case 'ArrowDown': delta = 7; break;
				case 'Home': delta = -date.getDay(); break;
				case 'PageUp': date = D.addMonths(date, -1); break;
				case 'PageDown': date = D.addMonths(date, 1); break;
				case 'Enter': case ' ': e.preventDefault(); state.select(date); return;
				case 'Escape': if (state.mode === 'menu') { e.preventDefault(); state.close(); } return;
				default: return;
			}
			e.preventDefault();
			if (delta) date = D.addDays(date, delta);
			// Shift the view only when the target leaves the visible month window
			// ([view.m, view.m + monthCount - 1] — multi-month shows several).
			const count = Math.max(1, state.monthCount || 1);
			const idx = (date.getFullYear() * 12 + date.getMonth()) - (state.view.y * 12 + (state.view.m - 1));
			if (idx < 0) state.setView(date.getFullYear(), date.getMonth() + 1);
			else if (idx >= count) state.setView(date.getFullYear(), date.getMonth() + 1 - (count - 1));
			const target = state.rootEl.querySelector('[role=grid] button[value="' + D.toISO(date) + '"]');
			if (target) { target.setAttribute('tabindex', '0'); target.focus(); }
		}

		/* ---- Config: the directive's value --------------------------- */
		// An object value is reactive config: { months, min, max, disabled, presets }.
		// min/max also read the element's native attributes.
		function applyAttrConfig(state, el) {
			const min = el.getAttribute('min');
			const max = el.getAttribute('max');
			if (min) state.min = D.fromISO(min);
			if (max) state.max = D.fromISO(max);
			const format = el.getAttribute('format');
			if (format) state.format = format;   // string presets only; objects/fns via config
		}
		function bindConfigValue(state, el, expression) {
			if (!expression) return;
			Alpine.effect(() => {
				let cfg;
				try { cfg = Alpine.evaluate(el, expression); } catch (_) { return; }
				if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
				let dirty = false;
				if (cfg.months) { const mc = Math.max(1, Math.min(4, parseInt(cfg.months, 10) || 1)); if (mc !== state.monthCount) { state.monthCount = mc; dirty = true; } }
				if (cfg.firstDay !== undefined) { const fd = parseFirstDay(cfg.firstDay); if (fd !== state.firstDay) { state.firstDay = fd; dirty = true; } }
				if (cfg.now !== undefined) { const v = cfg.now !== false; if (v !== state.showNow) { state.showNow = v; dirty = true; } }
				if (cfg.clear !== undefined) { const v = cfg.clear !== false; if (v !== state.showClear) { state.showClear = v; dirty = true; } }
				if (cfg.min !== undefined) { state.min = cfg.min ? D.fromISO(cfg.min) : null; dirty = true; }
				if (cfg.max !== undefined) { state.max = cfg.max ? D.fromISO(cfg.max) : null; dirty = true; }
				if (cfg.disabled !== undefined && (Array.isArray(cfg.disabled) || typeof cfg.disabled === 'function')) { state.disabled = cfg.disabled; dirty = true; }
				if (Array.isArray(cfg.presets)) { state.presets = cfg.presets; dirty = true; }
				if (cfg.format !== undefined) { state.format = cfg.format || null; dirty = true; }
				if (dirty) { state.bump(); if (state._mounted) state.render(); }
			});
		}
		/* ---- Reactive chrome — re-render when locale, direction, or resolved `_ui`
		 * text changes. Output comparison skips no-op _dataVersion bumps. */
		function bindReactiveRender(state) {
			if (state._uiEffectBound) return;
			state._uiEffectBound = true;
			Alpine.effect(() => {
				let locale = '', dir = '';
				try { const ls = Alpine.store('locale'); locale = ls?.current || document.documentElement.lang || ''; dir = ls?.direction || ''; } catch (_) { }
				try { void Alpine.store('data')?._dataVersion; } catch (_) { }
				const ui = window.ManifestUI.resolve('date', UI_FALLBACK);
				const key = locale + '|' + dir + '|' + JSON.stringify(ui);
				if (state._uiKey === key) return;
				const first = state._uiKey === undefined;
				state._uiKey = key;
				if (state._destroyed || first) return; // initial render happens at mount
				if (state._mounted) { state.render(); state.syncOut(); }
			});
		}

		function bindModel(state, el, modelExpr) {
			const read = Alpine.evaluateLater(el, modelExpr);
			state.modelGet = (cb) => { let out; read(v => { out = v; if (cb) cb(v); }); return out; };
			state.modelSet = (v) => { try { Alpine.evaluate(el, `${modelExpr} = ${JSON.stringify(v)}`); } catch (_) { } };
			// React to external model changes; syncOut writes the same value back (no loop).
			Alpine.effect(() => { read(v => { const iso = (v instanceof Date) ? D.toISO(v) : v; const cur = state._primaryValue(); if (typeof iso === 'string' && iso !== cur) { const tm = iso.match(/T(\d{2}:\d{2})/); if (tm) state.time = tm[1]; const d = D.fromISO(iso); state.selected = d; if (d) state.view = { y: d.getFullYear(), m: d.getMonth() + 1 }; state.bump(); if (state._mounted) { state.render(); state.syncOut(); } } }); });
		}

		function createDefaultMenu(fieldEl) {
			const menu = document.createElement('menu');
			menu.setAttribute('popover', '');
			menu.id = 'mnfst-dp-menu-' + (++_uid);
			document.body.appendChild(menu);
			return menu;
		}

		/* ---- Wiring an <input>/<button> field to a generated dropdown — the plugin
		 * owns this menu's open/close (a text <input> can't be a native popover
		 * invoker). Authored <dialog>/<menu> calendars are inline. */
		function wireField(fieldEl, expression, modifiers, cleanup) {
			const calendar = createDefaultMenu(fieldEl);
			const state = (calendar._dateState = createState(calendar));
			state.field = fieldEl;
			state.mode = 'menu';
			if (modifiers.includes('range')) state.selectionMode = 'range';
			else if (modifiers.includes('multiple')) state.selectionMode = 'multiple';
			if (modifiers.includes('time')) state.withTime = true;

			// Piggyback the input's authored type (format + no-JS fallback), then take over
			// with text+readonly so the styled calendar owns the UX.
			if (fieldEl.tagName === 'INPUT') {
				const authored = (fieldEl.getAttribute('type') || '').toLowerCase();
				if (authored === 'time') state.timeOnly = true;
				else if (authored === 'datetime-local') state.withTime = true;
				applyAttrConfig(state, fieldEl); // native min/max first
				try { fieldEl.type = 'text'; } catch (_) { }
				fieldEl.readOnly = true; fieldEl.autocomplete = 'off';
			} else {
				applyAttrConfig(state, fieldEl);
				// Text-only triggers: authored text is the placeholder the selection swaps.
				state.fieldPlaceholder = fieldEl.firstElementChild ? '' : fieldEl.textContent.trim();
			}

			// Object config in the value.
			bindConfigValue(state, fieldEl, expression);

			// Move the name onto a synthesized hidden (ISO) input so the form submits the
			// value, not the display text.
			const nameAttr = fieldEl.getAttribute('name');
			if (nameAttr && !state.hiddenInput) {
				const hidden = document.createElement('input');
				hidden.type = 'hidden'; hidden.name = nameAttr;
				fieldEl.after(hidden);
				state.hiddenInput = hidden;
				fieldEl._dpSynthesizedHidden = hidden;
				fieldEl.removeAttribute('name');
			}

			// x-model on the field wins over value.
			const modelExpr = fieldEl.getAttribute('x-model');
			if (modelExpr) bindModel(state, fieldEl, modelExpr);

			if (!state._mounted) { state.seed(); state.syncOut(); state.render(); state._mounted = true; }
			if (calendar.id) _registry[calendar.id] = state.api;
			// Also resolve $date(fieldId) when the calendar is an auto-generated menu.
			if (fieldEl.id) _registry[fieldEl.id] = state.api;

			// CSS anchor positioning (as in the dropdowns plugin); showPopover() on click
			// since a text <input> can't carry popovertarget.
			const anchorName = '--datepicker-' + (++_uid);
			fieldEl.style.setProperty('anchor-name', `${anchorName}, var(--co-anchor, --no-anchor)`);
			fieldEl.style.setProperty('--trigger-anchor', anchorName);
			calendar.style.setProperty('position-anchor', anchorName);
			fieldEl.setAttribute('aria-haspopup', 'menu');
			fieldEl.setAttribute('aria-controls', calendar.id);
			fieldEl.setAttribute('aria-expanded', 'false');
			calendar.addEventListener('toggle', (e) => fieldEl.setAttribute('aria-expanded', e.newState === 'open' ? 'true' : 'false'));
			fieldEl.addEventListener('click', () => state.open());

			// Reactive chrome re-render (locale, direction, _ui).
			bindReactiveRender(state);

			if (cleanup) cleanup(() => {
				if (fieldEl._dpSynthesizedHidden && fieldEl._dpSynthesizedHidden.isConnected) fieldEl._dpSynthesizedHidden.remove();
				if (state._timeMenuEl && state._timeMenuEl.isConnected) state._timeMenuEl.remove();
				if (calendar && calendar.isConnected) calendar.remove(); // the generated dropdown
				state._destroyed = true;
			});
		}

		/* ---- Register directive + magic ----------------------------- */
		Alpine.directive('date', (el, { modifiers, expression }, { cleanup }) => {
			const tag = el.tagName;

			// Inputs and buttons are field triggers; everything else IS a calendar.
			if (tag === 'INPUT' || tag === 'BUTTON') {
				wireField(el, expression, modifiers, cleanup);
				return;
			}

			// Authored calendar (<div>/<menu>/<dialog>) — always inline; native HTML owns open/close.
			const state = el._dateState || (el._dateState = createState(el));
			state.mode = 'inline';
			if (modifiers.includes('range')) state.selectionMode = 'range';
			else if (modifiers.includes('multiple')) state.selectionMode = 'multiple';
			if (modifiers.includes('time')) state.withTime = true;
			applyAttrConfig(state, el);
			bindConfigValue(state, el, expression);

			// x-model / value bind directly on an inline calendar.
			const modelExpr = el.getAttribute('x-model');
			if (modelExpr) bindModel(state, el, modelExpr);

			// Defer mount so linked fields can register first.
			setTimeout(() => {
				if (state._mounted) return;
				state.seed();
				state.render();
				state._mounted = true;
				if (el.id) _registry[el.id] = state.api;
				bindReactiveRender(state);
			}, 0);

			cleanup(() => {
				if (el.id) delete _registry[el.id];
				if (state._timeMenuEl && state._timeMenuEl.isConnected) state._timeMenuEl.remove();
				state._destroyed = true;
				delete el._dateState;
			});
		});

		Alpine.magic('date', (el) => {
			const local = findAncestorState(el);
			const byId = (id) => {
				if (!id) return local ? local.api : _nullApi;
				return _registry[id] || _nullApi;
			};
			return new Proxy(byId, {
				get(fn, prop) {
					if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => (local ? local.api.value : '');
					if (local && prop in local.api) return local.api[prop];
					return fn[prop];
				}
			});
		});
	}

	/* ---- Bootstrap shim (loader contract) --------------------------- */
	let datepickerPluginInitialized = false;
	let datepickerAlpineHasWalked = false;
	document.addEventListener('alpine:initialized', () => { datepickerAlpineHasWalked = true; });

	function ensureDatepickerPluginInitialized() {
		if (datepickerPluginInitialized) return;
		if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
		datepickerPluginInitialized = true;
		initializeDatepickerPlugin();
		if (datepickerAlpineHasWalked && typeof window.Alpine.initTree === 'function') {
			// querySelector can't prefix-match attribute names (x-date.range), so
			// scan attributes for the late-load self-walk.
			document.querySelectorAll('*').forEach(el => {
				if (el.__x) return;
				for (const a of el.attributes || []) {
					if (a.name === 'x-date' || a.name.startsWith('x-date.')) { window.Alpine.initTree(el); break; }
				}
			});
		}
	}
	window.ensureDatepickerPluginInitialized = ensureDatepickerPluginInitialized;

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureDatepickerPluginInitialized);
	document.addEventListener('alpine:init', ensureDatepickerPluginInitialized);
	if (window.Alpine && typeof window.Alpine.directive === 'function') setTimeout(ensureDatepickerPluginInitialized, 0);
	else {
		const check = setInterval(() => { if (window.Alpine?.directive) { clearInterval(check); ensureDatepickerPluginInitialized(); } }, 10);
		setTimeout(() => clearInterval(check), 5000);
	}
})();
