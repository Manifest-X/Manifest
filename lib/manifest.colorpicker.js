/* Manifest Color Picker

   Directive:  x-colorpicker[.<modifier>[="value"]]

     Root (no modifier): declares a picker container.
     Children (with modifier): declare hooks. Three families:

     • Layout (template OR instance — determined by host element tag)
         .solid               canvas + hue/alpha sliders + value + format
         .gradient            full gradient panel (layers container + layer template)
         .layer-options       one gradient layer's UI
         .gradient-layers     container holding cloned .layer-options instances
         .layer-stops-bar     stops bar (inside a layer)

     • Actions (click triggers behavior)
         .add-layer                    .apply-color          .grab-color
         .duplicate-layer              .remove-layer
         .flip-layer                   .rotate-layer
         .duplicate-stop               .delete-stop
         .set-gradient-type="linear|radial|conic"

     • Inputs (state-bound control)
         .set-canvas          .set-hue            .set-alpha
         .set-alpha-value     .set-color-space    .set-color-value
         .set-angle           .set-gradient-value

   Magic:  $colorpicker — returns the nearest ancestor picker's API
           for programmatic control (addLayer, setHue, layers, activeStop, ...).
*/

function initializeColorpickerPlugin() {

    // ---- Parse any CSS color string via the browser ----

    const parseCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });

    function parseCssColor(str) {
        if (!str || typeof str !== 'string') return null;
        str = str.trim();
        if (!str) return null;
        const hex8 = str.match(/^#([0-9a-f]{8})$/i);
        if (hex8) {
            const n = parseInt(hex8[1], 16);
            return { r: (n >> 24) & 255, g: (n >> 16) & 255, b: (n >> 8) & 255, a: (n & 255) / 255 };
        }
        const hex4 = str.match(/^#([0-9a-f]{4})$/i);
        if (hex4) {
            const c = hex4[1];
            return { r: parseInt(c[0]+c[0],16), g: parseInt(c[1]+c[1],16), b: parseInt(c[2]+c[2],16), a: parseInt(c[3]+c[3],16)/255 };
        }
        parseCtx.clearRect(0, 0, 1, 1);
        parseCtx.fillStyle = '#00000000';
        parseCtx.fillStyle = str;
        if (parseCtx.fillStyle === '#00000000' && str !== '#00000000' && str !== 'transparent') {
            parseCtx.fillStyle = '#01010101';
            parseCtx.fillStyle = str;
            if (parseCtx.fillStyle === '#01010101') return null;
        }
        parseCtx.fillRect(0, 0, 1, 1);
        const d = parseCtx.getImageData(0, 0, 1, 1).data;
        return { r: d[0], g: d[1], b: d[2], a: +(d[3] / 255).toFixed(3) };
    }

    // ---- Color conversions ----

    function rgbToHex(r, g, b) { return '#' + [r,g,b].map(v => Math.round(v).toString(16).padStart(2,'0')).join(''); }
    function rgbToHex8(r, g, b, a) { return '#' + [r,g,b,Math.round(a*255)].map(v => Math.round(v).toString(16).padStart(2,'0')).join(''); }

    function rgbToHsv(r, g, b) {
        r/=255; g/=255; b/=255;
        const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
        let h=0, s=max===0?0:d/max, v=max;
        if(d!==0){ if(max===r)h=((g-b)/d+(g<b?6:0))/6; else if(max===g)h=((b-r)/d+2)/6; else h=((r-g)/d+4)/6; }
        return {h:h*360, s:s*100, v:v*100};
    }

    function hsvToRgb(h, s, v) {
        h/=360; s/=100; v/=100;
        let r,g,b; const i=Math.floor(h*6), f=h*6-i, p=v*(1-s), q=v*(1-f*s), t=v*(1-(1-f)*s);
        switch(i%6){ case 0:r=v;g=t;b=p;break; case 1:r=q;g=v;b=p;break; case 2:r=p;g=v;b=t;break; case 3:r=p;g=q;b=v;break; case 4:r=t;g=p;b=v;break; case 5:r=v;g=p;b=q;break; }
        return {r:Math.round(r*255), g:Math.round(g*255), b:Math.round(b*255)};
    }

    function rgbToHsl(r, g, b) {
        r/=255; g/=255; b/=255;
        const max=Math.max(r,g,b), min=Math.min(r,g,b), l=(max+min)/2;
        let h=0, s=0;
        if(max!==min){ const d=max-min; s=l>0.5?d/(2-max-min):d/(max+min); if(max===r)h=((g-b)/d+(g<b?6:0))/6; else if(max===g)h=((b-r)/d+2)/6; else h=((r-g)/d+4)/6; }
        return {h:Math.round(h*360), s:Math.round(s*100), l:Math.round(l*100)};
    }

    function srgbToLinear(c){ return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4); }

    function rgbToOklch(r, g, b) {
        const lr=srgbToLinear(r/255), lg=srgbToLinear(g/255), lb=srgbToLinear(b/255);
        const l_=0.4122214708*lr+0.5363325363*lg+0.0514459929*lb, m_=0.2119034982*lr+0.6806995451*lg+0.1073969566*lb, s_=0.0883024619*lr+0.2817188376*lg+0.6299787005*lb;
        const l1=Math.cbrt(l_), m1=Math.cbrt(m_), s1=Math.cbrt(s_);
        const L=0.2104542553*l1+0.7936177850*m1-0.0040720468*s1, a=1.9779984951*l1-2.4285922050*m1+0.4505937099*s1, bk=0.0259040371*l1+0.7827717662*m1-0.8086757660*s1;
        let H=Math.atan2(bk,a)*180/Math.PI; if(H<0)H+=360;
        return {l:+(L*100).toFixed(2), c:+Math.sqrt(a*a+bk*bk).toFixed(4), h:+H.toFixed(1)};
    }

    const FORMATS = ['hex', 'rgb', 'hsl', 'oklch'];

    function roundA(a) { const v=Math.round(a*100); return v===100?'1':(v/100).toString(); }

    // Canonical dedupe key for a color or gradient value. Used to tag library swatches
    // with a `data-cp-key` that the picker can match against its current color to toggle
    // an `active` class. Parses any CSS color via parseCssColor → 8-digit hex. Gradients
    // are compared as their normalized CSS string.
    function _swatchKeyOf(value) {
        if (typeof value !== 'string') return null;
        const v = value.trim();
        if (!v) return null;
        if (v.includes('gradient(')) return v;
        const c = parseCssColor(v);
        if (!c) return null;
        return rgbToHex8(c.r, c.g, c.b, c.a);
    }

    function formatColor(r, g, b, a, mode) {
        const hasA = a < 1;
        switch (mode) {
            case 'hex': return hasA ? rgbToHex8(r,g,b,a) : rgbToHex(r,g,b);
            case 'rgb': return `rgb(${r} ${g} ${b}${hasA?' / '+roundA(a):''})`;
            case 'hsl': { const c=rgbToHsl(r,g,b); return `hsl(${c.h} ${c.s}% ${c.l}%${hasA?' / '+roundA(a):''})`; }
            case 'oklch': { const c=rgbToOklch(r,g,b); return `oklch(${c.l}% ${c.c} ${c.h}${hasA?' / '+roundA(a):''})`; }
            default: return rgbToHex(r,g,b);
        }
    }

    function detectFormat(str) {
        str = (str || '').trim().toLowerCase();
        if (str.startsWith('#')) return 'hex';
        if (str.startsWith('rgb')) return 'rgb';
        if (str.startsWith('hsl')) return 'hsl';
        if (str.startsWith('oklch')) return 'oklch';
        return null;
    }

    function colorToRgba(col) {
        const {r,g,b} = hsvToRgb(col.h, col.s, col.v);
        return col.a < 1 ? `rgba(${r},${g},${b},${col.a})` : rgbToHex(r,g,b);
    }

    // ---- Canvas (SV plane) ----

    function drawSvCanvas(canvas, hue) {
        // Cache the 2D context on the canvas element. No `willReadFrequently` —
        // we only ever write to this canvas, so we want GPU-accelerated compositing.
        const ctx = canvas._cpCtx || (canvas._cpCtx = canvas.getContext('2d'));
        const w = canvas.width, h = canvas.height;
        const hr = hsvToRgb(hue, 100, 100);
        const hG = ctx.createLinearGradient(0,0,w,0);
        hG.addColorStop(0,'#fff'); hG.addColorStop(1,`rgb(${hr.r},${hr.g},${hr.b})`);
        ctx.fillStyle = hG; ctx.fillRect(0,0,w,h);
        const vG = ctx.createLinearGradient(0,0,0,h);
        vG.addColorStop(0,'rgba(0,0,0,0)'); vG.addColorStop(1,'#000');
        ctx.fillStyle = vG; ctx.fillRect(0,0,w,h);
    }

    // ---- Gradient string builders ----

    const GRADIENT_TYPES = ['linear', 'radial', 'conic'];

    function buildLayerString(layer) {
        const stops = layer.stops.slice().sort((a,b) => a.position - b.position)
            .map(s => `${colorToRgba(s.color)} ${s.position}%`).join(', ');
        switch (layer.type) {
            case 'linear': return `linear-gradient(${layer.angle}deg, ${stops})`;
            case 'radial': return `radial-gradient(circle at ${layer.position.x}% ${layer.position.y}%, ${stops})`;
            case 'conic':  return `conic-gradient(from ${layer.angle}deg at ${layer.position.x}% ${layer.position.y}%, ${stops})`;
            default: return `linear-gradient(${layer.angle}deg, ${stops})`;
        }
    }

    function buildFullGradientString(layers) {
        return layers.map(buildLayerString).join(', ');
    }

    // ---- Gradient parsing (reverse of buildLayerString / buildFullGradientString) ----
    //
    // Parses a CSS gradient string back into the layers/stops structure the picker
    // uses internally. Tolerant of whatever the browser serializes from inline
    // styles (rgb(...) and rgba(...) instead of hex, etc.).

    // Split a string on top-level commas (commas not inside parentheses).
    function _splitTopLevelCommas(str) {
        const out = [];
        let depth = 0, start = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str[i];
            if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (c === ',' && depth === 0) { out.push(str.slice(start, i).trim()); start = i + 1; }
        }
        if (start < str.length) out.push(str.slice(start).trim());
        return out;
    }

    // Split a string into individual gradient calls — top-level segments that each
    // start with `<type>-gradient(`. Handles multi-layer gradients like
    // "linear-gradient(...), radial-gradient(...)".
    function _splitGradientLayers(str) {
        const segments = _splitTopLevelCommas(str);
        return segments.filter(s => /^(linear|radial|conic)-gradient\s*\(/i.test(s));
    }

    function _parseGradientLayer(layerStr) {
        const m = layerStr.match(/^(linear|radial|conic)-gradient\s*\(([\s\S]*)\)\s*$/i);
        if (!m) return null;
        const type = m[1].toLowerCase();
        const parts = _splitTopLevelCommas(m[2]);

        let angle = 90, x = 50, y = 50;
        let stopsStart = 0;
        const first = parts[0] || '';

        if (type === 'linear') {
            // "<angle>deg" prefix is optional; default 90 if absent
            const am = first.match(/^([-\d.]+)\s*deg/i);
            if (am) { angle = parseFloat(am[1]); stopsStart = 1; }
        } else if (type === 'radial') {
            // "circle at X% Y%" or similar — pull X/Y if present
            const pm = first.match(/at\s+([-\d.]+)%\s+([-\d.]+)%/i);
            if (pm) { x = parseFloat(pm[1]); y = parseFloat(pm[2]); stopsStart = 1; }
            else if (/^(circle|ellipse|closest|farthest)/i.test(first)) stopsStart = 1;
        } else if (type === 'conic') {
            const am = first.match(/from\s+([-\d.]+)\s*deg/i);
            const pm = first.match(/at\s+([-\d.]+)%\s+([-\d.]+)%/i);
            if (am) angle = parseFloat(am[1]);
            if (pm) { x = parseFloat(pm[1]); y = parseFloat(pm[2]); }
            if (am || pm) stopsStart = 1;
        }

        const stops = parts.slice(stopsStart).map(_parseGradientStop).filter(Boolean);
        if (stops.length === 0) return null;
        return { type, angle, position: { x, y }, stops };
    }

    // Parses "<color> <position>%" — color may be any CSS color form
    // (hex, rgb(), rgba(), hsl(), oklch(), named, etc.).
    function _parseGradientStop(s) {
        const trimmed = s.trim();
        // Position is the trailing "<num>%" — color is everything before
        const m = trimmed.match(/^(.+?)\s+([-\d.]+)%\s*$/);
        if (!m) return null;
        const rgb = parseCssColor(m[1].trim());
        if (!rgb) return null;
        const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        return {
            color: { h: hsv.h, s: hsv.s, v: hsv.v, a: rgb.a },
            position: parseFloat(m[2]),
            format: 'hex'
        };
    }

    function parseGradientString(str) {
        if (typeof str !== 'string') return null;
        const trimmed = str.trim();
        if (!/gradient\s*\(/i.test(trimmed)) return null;
        const layerStrs = _splitGradientLayers(trimmed);
        if (layerStrs.length === 0) return null;
        const layers = layerStrs.map(_parseGradientLayer).filter(Boolean);
        return layers.length ? layers : null;
    }

    // ---- Layer / stop factories ----

    function makeDefaultStop(hue, position) {
        return { color: { h: hue, s: 100, v: 100, a: 1 }, position, format: 'hex' };
    }

    function makeDefaultLayer() {
        return {
            type: 'linear', angle: 90, position: { x: 50, y: 50 },
            stops: [ makeDefaultStop(0, 0), makeDefaultStop(240, 100) ]
        };
    }

    // ---- Built-in preset palettes ----

    // Tailwind v4 default theme (exact OKLCH values from tailwindcss/theme.css)
    // Ref: tailwindlabs/tailwindcss — packages/tailwindcss/theme.css
    const TAILWIND_HUES = ['red','orange','amber','yellow','lime','green','emerald','teal','cyan','sky','blue','indigo','violet','purple','fuchsia','pink','rose','slate','gray','zinc','neutral','stone','mauve','olive','mist','taupe'];
    const TAILWIND_SHADES = ['50','100','200','300','400','500','600','700','800','900','950'];
    const TAILWIND_COLORS = {
        red:      ['oklch(97.1% 0.013 17.38)','oklch(93.6% 0.032 17.717)','oklch(88.5% 0.062 18.334)','oklch(80.8% 0.114 19.571)','oklch(70.4% 0.191 22.216)','oklch(63.7% 0.237 25.331)','oklch(57.7% 0.245 27.325)','oklch(50.5% 0.213 27.518)','oklch(44.4% 0.177 26.899)','oklch(39.6% 0.141 25.723)','oklch(25.8% 0.092 26.042)'],
        orange:   ['oklch(98% 0.016 73.684)','oklch(95.4% 0.038 75.164)','oklch(90.1% 0.076 70.697)','oklch(83.7% 0.128 66.29)','oklch(75% 0.183 55.934)','oklch(70.5% 0.213 47.604)','oklch(64.6% 0.222 41.116)','oklch(55.3% 0.195 38.402)','oklch(47% 0.157 37.304)','oklch(40.8% 0.123 38.172)','oklch(26.6% 0.079 36.259)'],
        amber:    ['oklch(98.7% 0.022 95.277)','oklch(96.2% 0.059 95.617)','oklch(92.4% 0.12 95.746)','oklch(87.9% 0.169 91.605)','oklch(82.8% 0.189 84.429)','oklch(76.9% 0.188 70.08)','oklch(66.6% 0.179 58.318)','oklch(55.5% 0.163 48.998)','oklch(47.3% 0.137 46.201)','oklch(41.4% 0.112 45.904)','oklch(27.9% 0.077 45.635)'],
        yellow:   ['oklch(98.7% 0.026 102.212)','oklch(97.3% 0.071 103.193)','oklch(94.5% 0.129 101.54)','oklch(90.5% 0.182 98.111)','oklch(85.2% 0.199 91.936)','oklch(79.5% 0.184 86.047)','oklch(68.1% 0.162 75.834)','oklch(55.4% 0.135 66.442)','oklch(47.6% 0.114 61.907)','oklch(42.1% 0.095 57.708)','oklch(28.6% 0.066 53.813)'],
        lime:     ['oklch(98.6% 0.031 120.757)','oklch(96.7% 0.067 122.328)','oklch(93.8% 0.127 124.321)','oklch(89.7% 0.196 126.665)','oklch(84.1% 0.238 128.85)','oklch(76.8% 0.233 130.85)','oklch(64.8% 0.2 131.684)','oklch(53.2% 0.157 131.589)','oklch(45.3% 0.124 130.933)','oklch(40.5% 0.101 131.063)','oklch(27.4% 0.072 132.109)'],
        green:    ['oklch(98.2% 0.018 155.826)','oklch(96.2% 0.044 156.743)','oklch(92.5% 0.084 155.995)','oklch(87.1% 0.15 154.449)','oklch(79.2% 0.209 151.711)','oklch(72.3% 0.219 149.579)','oklch(62.7% 0.194 149.214)','oklch(52.7% 0.154 150.069)','oklch(44.8% 0.119 151.328)','oklch(39.3% 0.095 152.535)','oklch(26.6% 0.065 152.934)'],
        emerald:  ['oklch(97.9% 0.021 166.113)','oklch(95% 0.052 163.051)','oklch(90.5% 0.093 164.15)','oklch(84.5% 0.143 164.978)','oklch(76.5% 0.177 163.223)','oklch(69.6% 0.17 162.48)','oklch(59.6% 0.145 163.225)','oklch(50.8% 0.118 165.612)','oklch(43.2% 0.095 166.913)','oklch(37.8% 0.077 168.94)','oklch(26.2% 0.051 172.552)'],
        teal:     ['oklch(98.4% 0.014 180.72)','oklch(95.3% 0.051 180.801)','oklch(91% 0.096 180.426)','oklch(85.5% 0.138 181.071)','oklch(77.7% 0.152 181.912)','oklch(70.4% 0.14 182.503)','oklch(60% 0.118 184.704)','oklch(51.1% 0.096 186.391)','oklch(43.7% 0.078 188.216)','oklch(38.6% 0.063 188.416)','oklch(27.7% 0.046 192.524)'],
        cyan:     ['oklch(98.4% 0.019 200.873)','oklch(95.6% 0.045 203.388)','oklch(91.7% 0.08 205.041)','oklch(86.5% 0.127 207.078)','oklch(78.9% 0.154 211.53)','oklch(71.5% 0.143 215.221)','oklch(60.9% 0.126 221.723)','oklch(52% 0.105 223.128)','oklch(45% 0.085 224.283)','oklch(39.8% 0.07 227.392)','oklch(30.2% 0.056 229.695)'],
        sky:      ['oklch(97.7% 0.013 236.62)','oklch(95.1% 0.026 236.824)','oklch(90.1% 0.058 230.902)','oklch(82.8% 0.111 230.318)','oklch(74.6% 0.16 232.661)','oklch(68.5% 0.169 237.323)','oklch(58.8% 0.158 241.966)','oklch(50% 0.134 242.749)','oklch(44.3% 0.11 240.79)','oklch(39.1% 0.09 240.876)','oklch(29.3% 0.066 243.157)'],
        blue:     ['oklch(97% 0.014 254.604)','oklch(93.2% 0.032 255.585)','oklch(88.2% 0.059 254.128)','oklch(80.9% 0.105 251.813)','oklch(70.7% 0.165 254.624)','oklch(62.3% 0.214 259.815)','oklch(54.6% 0.245 262.881)','oklch(48.8% 0.243 264.376)','oklch(42.4% 0.199 265.638)','oklch(37.9% 0.146 265.522)','oklch(28.2% 0.091 267.935)'],
        indigo:   ['oklch(96.2% 0.018 272.314)','oklch(93% 0.034 272.788)','oklch(87% 0.065 274.039)','oklch(78.5% 0.115 274.713)','oklch(67.3% 0.182 276.935)','oklch(58.5% 0.233 277.117)','oklch(51.1% 0.262 276.966)','oklch(45.7% 0.24 277.023)','oklch(39.8% 0.195 277.366)','oklch(35.9% 0.144 278.697)','oklch(25.7% 0.09 281.288)'],
        violet:   ['oklch(96.9% 0.016 293.756)','oklch(94.3% 0.029 294.588)','oklch(89.4% 0.057 293.283)','oklch(81.1% 0.111 293.571)','oklch(70.2% 0.183 293.541)','oklch(60.6% 0.25 292.717)','oklch(54.1% 0.281 293.009)','oklch(49.1% 0.27 292.581)','oklch(43.2% 0.232 292.759)','oklch(38% 0.189 293.745)','oklch(28.3% 0.141 291.089)'],
        purple:   ['oklch(97.7% 0.014 308.299)','oklch(94.6% 0.033 307.174)','oklch(90.2% 0.063 306.703)','oklch(82.7% 0.119 306.383)','oklch(71.4% 0.203 305.504)','oklch(62.7% 0.265 303.9)','oklch(55.8% 0.288 302.321)','oklch(49.6% 0.265 301.924)','oklch(43.8% 0.218 303.724)','oklch(38.1% 0.176 304.987)','oklch(29.1% 0.149 302.717)'],
        fuchsia:  ['oklch(97.7% 0.017 320.058)','oklch(95.2% 0.037 318.852)','oklch(90.3% 0.076 319.62)','oklch(83.3% 0.145 321.434)','oklch(74% 0.238 322.16)','oklch(66.7% 0.295 322.15)','oklch(59.1% 0.293 322.896)','oklch(51.8% 0.253 323.949)','oklch(45.2% 0.211 324.591)','oklch(40.1% 0.17 325.612)','oklch(29.3% 0.136 325.661)'],
        pink:     ['oklch(97.1% 0.014 343.198)','oklch(94.8% 0.028 342.258)','oklch(89.9% 0.061 343.231)','oklch(82.3% 0.12 346.018)','oklch(71.8% 0.202 349.761)','oklch(65.6% 0.241 354.308)','oklch(59.2% 0.249 0.584)','oklch(52.5% 0.223 3.958)','oklch(45.9% 0.187 3.815)','oklch(40.8% 0.153 2.432)','oklch(28.4% 0.109 3.907)'],
        rose:     ['oklch(96.9% 0.015 12.422)','oklch(94.1% 0.03 12.58)','oklch(89.2% 0.058 10.001)','oklch(81% 0.117 11.638)','oklch(71.2% 0.194 13.428)','oklch(64.5% 0.246 16.439)','oklch(58.6% 0.253 17.585)','oklch(51.4% 0.222 16.935)','oklch(45.5% 0.188 13.697)','oklch(41% 0.159 10.272)','oklch(27.1% 0.105 12.094)'],
        slate:    ['oklch(98.4% 0.003 247.858)','oklch(96.8% 0.007 247.896)','oklch(92.9% 0.013 255.508)','oklch(86.9% 0.022 252.894)','oklch(70.4% 0.04 256.788)','oklch(55.4% 0.046 257.417)','oklch(44.6% 0.043 257.281)','oklch(37.2% 0.044 257.287)','oklch(27.9% 0.041 260.031)','oklch(20.8% 0.042 265.755)','oklch(12.9% 0.042 264.695)'],
        gray:     ['oklch(98.5% 0.002 247.839)','oklch(96.7% 0.003 264.542)','oklch(92.8% 0.006 264.531)','oklch(87.2% 0.01 258.338)','oklch(70.7% 0.022 261.325)','oklch(55.1% 0.027 264.364)','oklch(44.6% 0.03 256.802)','oklch(37.3% 0.034 259.733)','oklch(27.8% 0.033 256.848)','oklch(21% 0.034 264.665)','oklch(13% 0.028 261.692)'],
        zinc:     ['oklch(98.5% 0 0)','oklch(96.7% 0.001 286.375)','oklch(92% 0.004 286.32)','oklch(87.1% 0.006 286.286)','oklch(70.5% 0.015 286.067)','oklch(55.2% 0.016 285.938)','oklch(44.2% 0.017 285.786)','oklch(37% 0.013 285.805)','oklch(27.4% 0.006 286.033)','oklch(21% 0.006 285.885)','oklch(14.1% 0.005 285.823)'],
        neutral:  ['oklch(98.5% 0 0)','oklch(97% 0 0)','oklch(92.2% 0 0)','oklch(87% 0 0)','oklch(70.8% 0 0)','oklch(55.6% 0 0)','oklch(43.9% 0 0)','oklch(37.1% 0 0)','oklch(26.9% 0 0)','oklch(20.5% 0 0)','oklch(14.5% 0 0)'],
        stone:    ['oklch(98.5% 0.001 106.423)','oklch(97% 0.001 106.424)','oklch(92.3% 0.003 48.717)','oklch(86.9% 0.005 56.366)','oklch(70.9% 0.01 56.259)','oklch(55.3% 0.013 58.071)','oklch(44.4% 0.011 73.639)','oklch(37.4% 0.01 67.558)','oklch(26.8% 0.007 34.298)','oklch(21.6% 0.006 56.043)','oklch(14.7% 0.004 49.25)'],
        mauve:    ['oklch(98.5% 0 0)','oklch(96% 0.003 325.6)','oklch(92.2% 0.005 325.62)','oklch(86.5% 0.012 325.68)','oklch(71.1% 0.019 323.02)','oklch(54.2% 0.034 322.5)','oklch(43.5% 0.029 321.78)','oklch(36.4% 0.029 323.89)','oklch(26.3% 0.024 320.12)','oklch(21.2% 0.019 322.12)','oklch(14.5% 0.008 326)'],
        olive:    ['oklch(98.8% 0.003 106.5)','oklch(96.6% 0.005 106.5)','oklch(93% 0.007 106.5)','oklch(88% 0.011 106.6)','oklch(73.7% 0.021 106.9)','oklch(58% 0.031 107.3)','oklch(46.6% 0.025 107.3)','oklch(39.4% 0.023 107.4)','oklch(28.6% 0.016 107.4)','oklch(22.8% 0.013 107.4)','oklch(15.3% 0.006 107.1)'],
        mist:     ['oklch(98.7% 0.002 197.1)','oklch(96.3% 0.002 197.1)','oklch(92.5% 0.005 214.3)','oklch(87.2% 0.007 219.6)','oklch(72.3% 0.014 214.4)','oklch(56% 0.021 213.5)','oklch(45% 0.017 213.2)','oklch(37.8% 0.015 216)','oklch(27.5% 0.011 216.9)','oklch(21.8% 0.008 223.9)','oklch(14.8% 0.004 228.8)'],
        taupe:    ['oklch(98.6% 0.002 67.8)','oklch(96% 0.002 17.2)','oklch(92.2% 0.005 34.3)','oklch(86.8% 0.007 39.5)','oklch(71.4% 0.014 41.2)','oklch(54.7% 0.021 43.1)','oklch(43.8% 0.017 39.3)','oklch(36.7% 0.016 35.7)','oklch(26.8% 0.011 36.5)','oklch(21.4% 0.009 43.1)','oklch(14.7% 0.004 49.3)']
    };
    function titleCase(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }
    // Tailwind as a single group with one sub-palette per hue.
    // `labels` (optional) localizes names: { _group, _base, _black, _white, red, orange, ... }.
    // Missing labels fall back to English title-case.
    function buildTailwindPreset(labels) {
        const L = labels || {};
        const groupName = L._group || 'Tailwind';
        const sub = {};
        for (const hue of TAILWIND_HUES) {
            const shades = TAILWIND_COLORS[hue];
            if (!shades) continue;
            const paletteLabel = L[hue] || titleCase(hue);
            sub[paletteLabel] = shades.map((value, i) => ({
                name: paletteLabel + ' ' + TAILWIND_SHADES[i],
                value
            }));
        }
        sub[L._base || 'Base'] = [
            { name: L._black || 'Black', value: '#000' },
            { name: L._white || 'White', value: '#fff' }
        ];
        return { [groupName]: sub };
    }

    // iOS system colors (light + dark, exact values from Apple HIG, iOS 15+)
    // Returns one group per color with the light/dark pair, plus a system-gray group.
    const IOS_SYSTEM_COLORS = [
        { name: 'red',     light: '#FF3B30', dark: '#FF453A' },
        { name: 'orange',  light: '#FF9500', dark: '#FF9F0A' },
        { name: 'yellow',  light: '#FFCC00', dark: '#FFD60A' },
        { name: 'green',   light: '#34C759', dark: '#30D158' },
        { name: 'mint',    light: '#00C7BE', dark: '#63E6E2' },
        { name: 'teal',    light: '#30B0C7', dark: '#40CBE0' },
        { name: 'cyan',    light: '#32ADE6', dark: '#64D2FF' },
        { name: 'blue',    light: '#007AFF', dark: '#0A84FF' },
        { name: 'indigo',  light: '#5856D6', dark: '#5E5CE6' },
        { name: 'purple',  light: '#AF52DE', dark: '#BF5AF2' },
        { name: 'pink',    light: '#FF2D55', dark: '#FF375F' },
        { name: 'brown',   light: '#A2845E', dark: '#AC8E68' }
    ];
    const IOS_SYSTEM_GRAYS = [
        { name: 'gray',  light: '#8E8E93', dark: '#8E8E93' },
        { name: 'gray2', light: '#AEAEB2', dark: '#636366' },
        { name: 'gray3', light: '#C7C7CC', dark: '#48484A' },
        { name: 'gray4', light: '#D1D1D6', dark: '#3A3A3C' },
        { name: 'gray5', light: '#E5E5EA', dark: '#2C2C2E' },
        { name: 'gray6', light: '#F2F2F7', dark: '#1C1C1E' }
    ];
    // iOS as a single group with 4 sub-palettes. `labels` localizes:
    //   { _group, _colorLight, _colorDark, _shadesLight, _shadesDark, red, orange, ..., gray, gray2, ... }
    function buildIosPreset(labels) {
        const L = labels || {};
        const groupName = L._group || 'iOS';
        // Swatch names are prefixed with the tone ("Light - " / "Dark - ") so users
        // can still distinguish them by name once a color lands in Recent (where
        // palette context is lost). The `_lightPrefix` / `_darkPrefix` meta keys
        // let devs translate or remove the prefixes.
        const lightPrefix = L._lightPrefix != null ? L._lightPrefix : 'Light - ';
        const darkPrefix  = L._darkPrefix  != null ? L._darkPrefix  : 'Dark - ';
        const baseColorName = (c) => L[c.name] || titleCase(c.name);
        const formatGray = (name) => {
            if (L[name]) return L[name];
            const m = name.match(/^(gray)(\d+)?$/);
            return m ? (titleCase(m[1]) + (m[2] ? ' ' + m[2] : '')) : titleCase(name);
        };
        // Each tone gets one palette: system colors first, then grayscale shades.
        const light = [
            ...IOS_SYSTEM_COLORS.map(c => ({ name: lightPrefix + baseColorName(c), value: c.light })),
            ...IOS_SYSTEM_GRAYS.map(g => ({ name: lightPrefix + formatGray(g.name), value: g.light }))
        ];
        const dark = [
            ...IOS_SYSTEM_COLORS.map(c => ({ name: darkPrefix + baseColorName(c), value: c.dark })),
            ...IOS_SYSTEM_GRAYS.map(g => ({ name: darkPrefix + formatGray(g.name), value: g.dark }))
        ];
        return {
            [groupName]: {
                [L._light || 'Light']: light,
                [L._dark  || 'Dark']:  dark
            }
        };
    }

    // ---- Library data normalization ----

    // Normalize into: Group[] where each Group = { name?, colors?: Swatch[], palettes?: Palette[], ...extras }
    // A Group has EITHER flat `colors` OR nested `palettes`, never both. Each Palette = { name?, colors: Swatch[], ...extras }.
    // Swatch = { name?, value, ...extras }. Hierarchy is strictly Group > Palette > Swatch (no deeper nesting).
    // Filter proxy/magic noise: drop $-prefixed keys (Manifest magic like $route, $x, $watch),
    // symbol keys, function values, and the few inherited Object.prototype names that can leak
    // through exotic proxies.
    const _LIB_PROTO_NOISE = new Set(['valueOf', 'toString', 'constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']);
    function _cleanLibraryEntries(input) {
        return Object.entries(input).filter(([k, v]) => {
            if (typeof k !== 'string') return false;
            if (k.startsWith('$')) return false;   // Manifest magic ($route, $locale, $x, ...)
            if (k.startsWith('_')) return false;   // Manifest data metadata (_loadedFrom, _locale, _sourceType, ...)
            if (k === 'contentType') return false; // Manifest fetched-resource metadata
            if (_LIB_PROTO_NOISE.has(k)) return false;
            if (v == null) return false;
            if (typeof v === 'function') return false;
            return true;
        });
    }

    function normalizeLibraryInput(input) {
        if (input == null) return [];
        if (Array.isArray(input)) {
            const firstObjChild = input.find(x => x && typeof x === 'object' && !Array.isArray(x));
            const looksLikeGroups = firstObjChild && ('colors' in firstObjChild || 'items' in firstObjChild || 'palettes' in firstObjChild || 'subgroups' in firstObjChild);
            if (looksLikeGroups) return input.map(g => normalizeGroup(g, g.name));
            return [{ colors: normalizeColorList(input) }];
        }
        if (typeof input === 'object') {
            return _cleanLibraryEntries(input).map(([k, v]) => normalizeGroup(v, k));
        }
        return [];
    }

    function normalizeGroup(input, groupName) {
        if (input == null) return { name: groupName, colors: [] };

        // Explicit metadata form
        if (!Array.isArray(input) && typeof input === 'object'
            && ('colors' in input || 'items' in input || 'palettes' in input || 'subgroups' in input)) {
            const out = { ...input, name: input._group || input.name || groupName };
            const palettesSrc = input.palettes || input.subgroups;
            if (palettesSrc) {
                out.palettes = (palettesSrc || []).map(p => normalizePalette(p, p?.name));
                delete out.subgroups;
            } else {
                out.colors = normalizeColorList(input.colors || input.items || []);
            }
            return out;
        }

        // Array → flat colors list
        if (Array.isArray(input)) {
            return { name: groupName, colors: normalizeColorList(input) };
        }

        // Object — `_group` meta overrides heading, nested values = palettes, string values = flat colors
        if (typeof input === 'object') {
            const resolvedName = (typeof input._group === 'string') ? input._group : groupName;
            const entries = _cleanLibraryEntries(input);
            const hasNestedValues = entries.some(([, v]) => v && typeof v === 'object');
            if (hasNestedValues) {
                return {
                    name: resolvedName,
                    palettes: entries.map(([k, v]) => normalizePalette(v, k))
                };
            }
            return { name: resolvedName, colors: normalizeColorList(Object.fromEntries(entries)) };
        }

        return { name: groupName, colors: [] };
    }

    // Merge built-in Recent + Tailwind + iOS into a single default data object.
    // Used when `x-colorpicker.library` has no expression AND no ancestor $x data.
    // Optional `labels` is forwarded to the Tailwind / iOS builders for localization.
    function buildDefaultLibrary(labels) {
        const L = labels || {};
        return {
            [L._recent || 'Recent']: _recentStore.list.slice(0, _recentMax),
            ...buildTailwindPreset(L.tailwind),
            ...buildIosPreset(L.ios)
        };
    }

    // ---- Auto-discovery of colorpicker data sources ----
    //
    // Devs register data sources in manifest.json using the standard Manifest conventions,
    // then flag which ones contain color library content via a top-level `colorpicker` entry:
    //
    //   {
    //     "data": {
    //       "myColors": "/data/colors.yaml"                              // non-localized
    //       "brand":    { "en": "/data/brand.en.yaml", "fr": "..." }     // per-locale
    //     },
    //     "colorpicker": "myColors"                                       // single source
    //     "colorpicker": ["myColors", "brand"]                            // multiple sources
    //   }
    //
    // The colorpicker plugin scans $x.manifest.data for entries flagged with a
    // `colorpicker:` key, then merges the loaded $x.<name> values in declaration
    // order. Each source may contain:
    //   _tailwind:   (optional) replaces the built-in Tailwind group entirely
    //   _ios:        (optional) replaces the built-in iOS group entirely
    //   <Any Name>:  custom groups appended to the library after built-ins
    //
    // Presence of _tailwind / _ios is "all or nothing" — no merge with built-in data.
    // If multiple flagged sources both include _tailwind, the LAST source wins.

    // Manifest's data proxy returns an empty object for ANY property access (graceful chain),
    // so `src._tailwind` always looks truthy. We only treat an override as real if the source
    // actually declared the key (`in` operator) AND the value has real content.
    function _hasRealContent(v) {
        if (v == null || typeof v !== 'object') return false;
        return Object.keys(v).some(k => !k.startsWith('$')
            && k !== 'valueOf' && k !== 'toString'
            && k !== 'contentType');
    }

    // Takes an array of resolved source values, extracts _tailwind / _ios overrides and
    // custom groups from each, and returns the final normalized groups array.
    function composeLibraryFromSources(sources) {
        let tailwindOverride = null;
        let iosOverride = null;
        const customGroups = [];

        for (const src of sources) {
            if (src == null || typeof src !== 'object' || Array.isArray(src)) continue;

            // Extract override blocks only if actually declared in source AND have real content.
            if ('_tailwind' in src && _hasRealContent(src._tailwind)) tailwindOverride = src._tailwind;
            if ('_ios'      in src && _hasRealContent(src._ios))      iosOverride      = src._ios;

            // All other (non-reserved, non-metadata) keys become custom groups
            for (const [k, v] of _cleanLibraryEntries(src)) {
                if (k === '_tailwind' || k === '_ios') continue;
                if (!_hasRealContent(v)) continue;
                customGroups.push(normalizeGroup(v, k));
            }
        }

        // Assemble final group order: Recent → custom → Tailwind → iOS.
        // Recent may be empty (pre-use state) — we render the group only when it has content.
        const recent = _recentStore.list.slice(0, _recentMax);
        const groups = [];
        if (recent.length) {
            const recentGroup = normalizeGroup(recent, 'Recent');
            recentGroup._isRecent = true;  // marker for contextmenu binding
            groups.push(recentGroup);
        }

        groups.push(...customGroups);

        if (tailwindOverride) {
            // `_group` meta inside the override becomes the group heading; default to "Tailwind"
            groups.push(normalizeGroup(tailwindOverride, tailwindOverride._group || 'Tailwind'));
        } else {
            groups.push(...normalizeLibraryInput(buildTailwindPreset()));
        }

        if (iosOverride) {
            groups.push(normalizeGroup(iosOverride, iosOverride._group || 'iOS'));
        } else {
            groups.push(...normalizeLibraryInput(buildIosPreset()));
        }

        return groups;
    }

    // Walk a normalized groups array and resolve any reference-style strings in
    // user-facing labels (group / palette / swatch names) against Alpine's scope.
    // Two reference shapes are recognized:
    //   • Bare path:  "$x.colorLabels.primary"           → Alpine.evaluate(...)
    //   • Template:   "${$locale.t('brand.primary')}"     → Alpine.evaluate(...) as a literal
    // Plain strings pass through unchanged. Failed lookups return the original
    // string so a missing key surfaces as-is rather than rendering empty.
    //
    // Reading via Alpine.evaluate inside the surrounding render effect registers
    // reactive deps on the referenced data — locale switches and content updates
    // re-trigger the render automatically.
    function _resolveLibraryRefs(groups) {
        if (!Array.isArray(groups) || groups.length === 0) return groups;
        const ctx = document.body;
        const resolve = (val) => {
            if (typeof val !== 'string' || val.length === 0) return val;
            const trimmed = val.trim();
            const isBareRef = trimmed.startsWith('$x.') || trimmed.startsWith('$locale')
                || trimmed.startsWith('$x[') || trimmed.startsWith('$locale[');
            const hasInterp = /\$\{[^}]+\}/.test(trimmed);
            if (!isBareRef && !hasInterp) return val;
            try {
                if (window.Alpine?.evaluate) {
                    const expr = isBareRef && !hasInterp ? trimmed : '`' + trimmed + '`';
                    const out = Alpine.evaluate(ctx, expr);
                    if (out == null) return val;
                    return typeof out === 'string' ? out : String(out);
                }
            } catch {}
            return val;
        };
        for (const g of groups) {
            if (g && typeof g.name === 'string') g.name = resolve(g.name);
            if (Array.isArray(g?.palettes)) {
                for (const p of g.palettes) {
                    if (p && typeof p.name === 'string') p.name = resolve(p.name);
                    if (Array.isArray(p?.colors)) {
                        for (const c of p.colors) {
                            if (c && typeof c.name === 'string') c.name = resolve(c.name);
                        }
                    }
                }
            }
            if (Array.isArray(g?.colors)) {
                for (const c of g.colors) {
                    if (c && typeof c.name === 'string') c.name = resolve(c.name);
                }
            }
        }
        return groups;
    }

    // Returns an object that is BOTH callable (for localization) AND spreadable (for composition).
    // `builder` is a function that takes optional labels and returns a preset object.
    // Spreading the returned value exposes the default (unlabeled) preset's top-level keys.
    function _makeCallablePreset(builder) {
        const fn = (labels) => builder(labels);
        Object.assign(fn, builder()); // default preset's keys become own enumerable props on fn
        return fn;
    }

    // Render a group by cloning the group template and expanding nested templates in place.
    // Returns a fragment with all top-level elements (scope applied to the first). `isRecent`
    // threads down so palette/swatch layers can pick the Recent-specific swatch template.
    function renderLibraryGroup(groupTpl, group) {
        const frag = groupTpl.content.cloneNode(true);
        const primary = frag.firstElementChild;
        if (!primary) return frag;
        primary.setAttribute('x-data', '{ group: ' + _jsonStringifyForAlpine(group) + ' }');

        const isRecent = !!group._isRecent;

        // Normalize: flat groups become single unnamed palette so templates work uniformly
        const palettes = (group.palettes && group.palettes.length)
            ? group.palettes
            : (group.colors && group.colors.length ? [{ name: null, colors: group.colors }] : []);

        const paletteTpl = frag.querySelector('template[x-colorpicker\\.library-palette]');
        if (paletteTpl) {
            const parent = paletteTpl.parentNode;
            for (const p of palettes) parent.insertBefore(renderLibraryPalette(paletteTpl, p, isRecent), paletteTpl);
            paletteTpl.remove();
        } else {
            // No palette template — look for a swatch template directly inside the group.
            // Prefer the Recent-specific template for Recent groups, else fall back.
            const swatchTpl = (isRecent ? frag.querySelector('template[x-colorpicker\\.library-recent-swatch]') : null)
                           || frag.querySelector('template[x-colorpicker\\.library-swatch]');
            if (swatchTpl) {
                const parent = swatchTpl.parentNode;
                const allColors = palettes.flatMap(p => p.colors || []);
                for (const sw of allColors) parent.insertBefore(renderLibrarySwatch(swatchTpl, sw), swatchTpl);
                swatchTpl.remove();
            }
        }
        return frag;
    }

    function renderLibraryPalette(paletteTpl, palette, isRecent) {
        const frag = paletteTpl.content.cloneNode(true);
        const primary = frag.firstElementChild;
        if (!primary) return frag;
        primary.setAttribute('x-data', '{ palette: ' + _jsonStringifyForAlpine(palette) + ' }');

        // Recent palettes prefer library-recent-swatch template if defined.
        const swatchTpl = (isRecent ? frag.querySelector('template[x-colorpicker\\.library-recent-swatch]') : null)
                       || frag.querySelector('template[x-colorpicker\\.library-swatch]');
        if (swatchTpl) {
            const parent = swatchTpl.parentNode;
            for (const sw of (palette.colors || [])) parent.insertBefore(renderLibrarySwatch(swatchTpl, sw), swatchTpl);
            swatchTpl.remove();
        }
        return frag;
    }

    // Per-clone counter for uniquifying nested dropdown/menu ids — mirrors the scheme
    // used for gradient layer clones. Only menus that live INSIDE the swatch template
    // get uniquified; menus placed at the library root are left alone (shared).
    let _swatchCloneCounter = 0;

    function renderLibrarySwatch(swatchTpl, swatch) {
        const frag = swatchTpl.content.cloneNode(true);
        const primary = frag.firstElementChild;
        if (!primary) return frag;
        // Apply the swatch scope to the primary element (typically the swatch button).
        // Sibling elements like nested menus don't need swatch scope — their actions
        // read from the dropdowns plugin's trigger ref.
        primary.setAttribute('x-data', '{ swatch: ' + _jsonStringifyForAlpine(swatch) + ' }');
        // Raw value + canonical key go on BOTH the actual apply-color element AND the
        // primary wrapper (if different). That way `_updateActiveSwatches` can toggle
        // `.active` on both, and dev CSS targeting either selector — the wrapper div
        // (for layout effects like `order: -1`) or the button (for box-shadow) — works.
        if (swatch && typeof swatch.value === 'string') {
            const applyEl = frag.querySelector('[x-colorpicker\\.apply-color]');
            const key = _swatchKeyOf(swatch.value);
            const targets = new Set();
            if (primary) targets.add(primary);
            if (applyEl) targets.add(applyEl);
            for (const t of targets) {
                t.setAttribute('data-cp-value', swatch.value);
                if (key) t.setAttribute('data-cp-key', key);
            }
        }
        // Uniquify any nested dropdown/menu ids so per-swatch context menus don't
        // collide. Skipped automatically when the menu lives outside the template.
        uniquifyDropdownIdsIn(frag, 'swatch-' + (++_swatchCloneCounter));
        return frag;
    }

    // Default fallback: if no library template supplied, render a small heading per group
    // and a flex-wrap row of apply-color spans for each swatch.
    function renderDefaultGroup(group) {
        const root = document.createElement('div');
        root.setAttribute('data-cp-library-group', group.name || '');
        if (group.name) {
            const h = document.createElement('small');
            h.textContent = group.name;
            root.appendChild(h);
        }
        const palettes = (group.palettes && group.palettes.length)
            ? group.palettes
            : (group.colors && group.colors.length ? [{ name: null, colors: group.colors }] : []);
        for (const p of palettes) {
            if (p.name) {
                const ph = document.createElement('small');
                ph.textContent = p.name;
                root.appendChild(ph);
            }
            const row = document.createElement('div');
            row.className = 'swatches';
            for (const sw of (p.colors || [])) {
                const span = document.createElement('span');
                span.setAttribute('x-colorpicker.apply-color', '');
                span.style.background = sw.value;
                span.title = sw.name || sw.value;
                row.appendChild(span);
            }
            root.appendChild(row);
        }
        return root;
    }

    function normalizePalette(input, paletteName) {
        if (input == null) return { name: paletteName, colors: [] };
        if (Array.isArray(input)) return { name: paletteName, colors: normalizeColorList(input) };
        if (typeof input === 'object') {
            // Meta key `_name` overrides the display name (lets devs keep object keys stable
            // across locales while translating visible text).
            const displayName = (typeof input._name === 'string') ? input._name : (input.name || paletteName);
            // Explicit `_colors` / `colors` / `items` key holds the swatch list — use when
            // you need to pair `_name` with an array of bare hex strings (YAML can't mix
            // object keys and sequence items in the same node).
            if ('_colors' in input || 'colors' in input || 'items' in input) {
                return {
                    ...input,
                    name: displayName,
                    colors: normalizeColorList(input._colors || input.colors || input.items || [])
                };
            }
            return { name: displayName, colors: normalizeColorList(input) };
        }
        return { name: paletteName, colors: [] };
    }

    // Accepts swatch forms:
    //   "#hex"                                → { value }
    //   { name, value }                       → plain
    //   { _name, _value }                     → meta-key form (localization-friendly)
    function _coerceSwatch(item, fallbackName) {
        if (item == null) return null;
        if (typeof item === 'string') return fallbackName ? { name: fallbackName, value: item } : { value: item };
        if (typeof item === 'object') {
            const name  = (typeof item._name  === 'string') ? item._name  : (item.name || fallbackName);
            const value = (typeof item._value === 'string') ? item._value : item.value;
            if (value == null) return null;
            return name ? { name, value } : { value };
        }
        return null;
    }

    function normalizeColorList(input) {
        if (input == null) return [];
        if (Array.isArray(input)) {
            return input.map(item => _coerceSwatch(item)).filter(Boolean);
        }
        if (typeof input === 'object') {
            // Filter `_`-prefixed meta keys (e.g., `_name`, `_group`) so they're not mistaken for shades.
            return Object.entries(input)
                .filter(([k]) => !k.startsWith('_'))
                .map(([name, value]) => _coerceSwatch(value, name))
                .filter(Boolean);
        }
        return [];
    }

    // ---- Recent (cookie-backed, shared across all pickers) ----

    const RECENT_COOKIE = 'manifest-colorpicker-recent';
    let _recentMax = 10;
    const _recentStore = window.Alpine?.reactive ? Alpine.reactive({ list: [] }) : { list: [] };

    function loadRecent() {
        try {
            const match = document.cookie.split('; ').find(c => c.startsWith(RECENT_COOKIE + '='));
            if (!match) return [];
            const raw = decodeURIComponent(match.split('=')[1] || '');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    function saveRecent() {
        try {
            const val = encodeURIComponent(JSON.stringify(_recentStore.list));
            const exp = new Date(); exp.setFullYear(exp.getFullYear() + 1);
            document.cookie = RECENT_COOKIE + '=' + val + '; path=/; expires=' + exp.toUTCString() + '; SameSite=Lax';
        } catch {}
    }
    function pushRecent(value) {
        if (!value || typeof value !== 'string') return;
        const v = value.trim();
        if (!v) return;
        const list = _recentStore.list;
        const existingIdx = list.indexOf(v);
        if (existingIdx !== -1) list.splice(existingIdx, 1);
        list.unshift(v);
        while (list.length > _recentMax) list.pop();
        saveRecent();
    }
    function clearRecent() { _recentStore.list = []; saveRecent(); }
    function removeRecent(value) {
        const idx = _recentStore.list.indexOf(value);
        if (idx !== -1) { _recentStore.list.splice(idx, 1); saveRecent(); }
    }
    // Initial load from cookie
    _recentStore.list = loadRecent();

    // ---- Default fallback templates (used when developer doesn't supply their own) ----

    // Solid-options panel — used both as a top-level tab body and as the
    // accordion content under each gradient stop.
    const DEFAULT_SOLID_TEMPLATE_HTML = `
        <div>
            <div class="canvas-wrapper">
                <canvas x-colorpicker.set-canvas></canvas>
                <div class="color-reticle"></div>
            </div>
            <div class="solid-options-inputs">
                <input type="range" x-colorpicker.set-hue class="hue" />
                <input type="range" x-colorpicker.set-alpha class="alpha" />
                <div>
                    <button x-dropdown="color-space-menu" x-colorpicker.set-color-space class="ghost sm" aria-label="Color space"></button>
                    <menu popover id="color-space-menu">
                        <li x-colorpicker.set-color-space="hex">Hex</li>
                        <li x-colorpicker.set-color-space="rgb">RGB</li>
                        <li x-colorpicker.set-color-space="hsl">HSL</li>
                        <li x-colorpicker.set-color-space="oklch">OKLCH</li>
                        <hr>
                        <li x-colorpicker.grab-color><span x-icon class="color-icon-grab"></span><span>Grab color</span></li>
                    </menu>
                    <input type="text" x-colorpicker.set-color-value class="ghost sm" onClick="this.select()" />
                    <input type="number" x-colorpicker.set-alpha-value class="ghost sm no-spinner" min="0" max="100" step="1" onClick="this.select()" />
                </div>
            </div>
        </div>
    `;

    // Gradient layer template — one of these per layer clone. Includes the
    // gradient-type dropdown (with reactive icon class), angle input, stops bar
    // with right-click context menu (Duplicate/Delete + inline library), and
    // the per-stop solid-panel accordion.
    const DEFAULT_LAYER_TEMPLATE_HTML = `
        <div>
            <div class="layer-options-wrapper">
                <div class="layer-options-inputs">
                    <button class="ghost sm" x-dropdown="gradient-layer-options" aria-label="Layer options"><span :class="'gradient-layer-icon-' + layerType" x-icon></span></button>
                    <menu popover id="gradient-layer-options">
                        <li x-colorpicker.set-gradient-type="linear">
                            <span x-icon class="gradient-layer-icon-linear"></span><span>Linear Gradient</span>
                        </li>
                        <li x-colorpicker.set-gradient-type="radial">
                            <span x-icon class="gradient-layer-icon-radial"></span><span>Radial Gradient</span>
                        </li>
                        <li x-colorpicker.set-gradient-type="conic">
                            <span x-icon class="gradient-layer-icon-conic"></span><span>Conic Gradient</span>
                        </li>
                        <hr>
                        <li x-colorpicker.rotate-layer>Rotate 90°</li>
                        <li x-colorpicker.flip-layer>Flip Direction</li>
                        <hr>
                        <li x-colorpicker.add-layer-above>Add Above</li>
                        <li x-colorpicker.add-layer-below>Add Below</li>
                        <li x-colorpicker.duplicate-layer>Duplicate</li>
                        <hr>
                        <li x-colorpicker.move-layer-up :disabled="layerIndex === 0">Move Up</li>
                        <li x-colorpicker.move-layer-down :disabled="layerIndex === layerCount - 1">Move Down</li>
                        <hr>
                        <li x-colorpicker.remove-layer :disabled="layerCount === 1" class="negative">Remove</li>
                    </menu>

                    <div class="layer-angle-wrapper">
                        <input type="number" x-colorpicker.set-angle class="ghost sm no-spinner" min="0" max="360" onclick="select()" />
                        <span>°</span>
                    </div>

                    <div x-colorpicker.layer-stops-bar class="gradient-layer" x-dropdown.context="stop-context-menu"></div>
                    <menu popover id="stop-context-menu" class="stop-context-menu">
                        <li x-colorpicker.duplicate-stop>Duplicate</li>
                        <li x-colorpicker.delete-stop class="negative">Delete</li>
                        <hr>
                        <div x-colorpicker.library></div>
                    </menu>
                </div>

                <div x-colorpicker.solid></div>
            </div>
        </div>
    `;

    // Gradient panel — the entire Gradient tab body. Hosts the layer template
    // (cloned per layer), the layers container, and the editable CSS string.
    const DEFAULT_GRADIENT_TEMPLATE_HTML = `
        <div>
            <div x-colorpicker.gradient-layers></div>
            <template x-colorpicker.layer-options>
                ${DEFAULT_LAYER_TEMPLATE_HTML}
            </template>
            <div class="gradient-value-wrapper">
                <textarea x-colorpicker.set-gradient-value class="ghost sm" spellcheck="false" rows="3" onclick="select()"></textarea>
            </div>
        </div>
    `;

    // Full default UI — used when an x-colorpicker has no children and no
    // declared templates. Mirrors the canonical custom-picker structure:
    // tabs row, three tab bodies, three matching templates.
    const DEFAULT_FULL_UI_HTML = `
        <div x-data="{ tab: 'solid' }">

            <div class="tabs-wrapper" data-cp-tabs>
                <button data-cp-tab="solid" class="ghost sm" :class="tab === 'solid' && 'selected'" @click="tab = 'solid'" x-tooltip="Solid" aria-label="Solid"><span x-icon class="color-icon-solid"></span></button>
                <button data-cp-tab="gradient" class="ghost sm" :class="tab === 'gradient' && 'selected'" @click="tab = 'gradient'" x-tooltip="Gradient" aria-label="Gradient"><span x-icon class="color-icon-gradient"></span></button>
                <button data-cp-tab="library" class="ghost sm" :class="tab === 'library' && 'selected'" @click="tab = 'library'" x-tooltip="Library" aria-label="Library"><span x-icon class="color-icon-library"></span></button>
            </div>

            <div data-cp-panel="solid" x-colorpicker.solid x-show="tab === 'solid'"></div>
            <div data-cp-panel="gradient" x-colorpicker.gradient x-show="tab === 'gradient'"></div>
            <div data-cp-panel="library" x-colorpicker.library x-show="tab === 'library'"></div>

            <template x-colorpicker.solid>
                ${DEFAULT_SOLID_TEMPLATE_HTML}
            </template>

            <template x-colorpicker.gradient>
                ${DEFAULT_GRADIENT_TEMPLATE_HTML}
            </template>
        </div>
    `;

    // Parse default template HTML ONCE at module load. Subsequent uses clone the
    // already-parsed DocumentFragment — avoids re-running the HTML parser per layer.
    function parseOnce(html) {
        const t = document.createElement('template');
        t.innerHTML = html.trim();
        return t;
    }
    const _defaultSolidTpl    = parseOnce(DEFAULT_SOLID_TEMPLATE_HTML);
    const _defaultLayerTpl    = parseOnce(DEFAULT_LAYER_TEMPLATE_HTML);
    const _defaultGradientTpl = parseOnce(DEFAULT_GRADIENT_TEMPLATE_HTML);
    const _defaultFullUiTpl   = parseOnce(DEFAULT_FULL_UI_HTML);

    // Default library layout — group > palette > swatch nesting. Mirrors the
    // canonical custom-picker library template. Used when no dev-provided
    // <template x-colorpicker.library> is present.
    // Recent swatches use the per-clone nested context-menu pattern (each
    // Recent swatch carries its own uniquified menu via uniquifyDropdownIdsIn,
    // matching the convention for layer dropdowns).
    const DEFAULT_LIBRARY_LAYOUT_HTML = `
        <div class="library-wrapper">

            <template x-colorpicker.library-group>
                <div class="library-group">
                    <small x-text="group.name"></small>

                    <template x-colorpicker.library-palette>
                        <div class="library-palette">

                            <template x-colorpicker.library-swatch>
                                <button x-colorpicker.apply-color :style="\`background: \${swatch.value}\`" x-tooltip="\`\${swatch.name || swatch.value}\`"></button>
                            </template>

                            <template x-colorpicker.library-recent-swatch>
                                <div>
                                    <button x-colorpicker.apply-color x-dropdown.context="recent-menu" :style="\`background: \${swatch.value}\`" x-tooltip="\`\${swatch.name || swatch.value}\`"></button>
                                    <menu popover id="recent-menu">
                                        <li x-colorpicker.remove-recent>Remove</li>
                                    </menu>
                                </div>
                            </template>

                        </div>
                    </template>
                </div>
            </template>

        </div>
    `;
    const _defaultLibraryLayoutTpl = parseOnce(DEFAULT_LIBRARY_LAYOUT_HTML);

    // ---- Per-picker state ----

    let pickerCounter = 0;

    // Reactive registry of pickers keyed by element ID.
    // Consumers read via the magic; reads are tracked even for not-yet-registered IDs,
    // so bindings resolve correctly when a picker mounts later in the DOM.
    const _pickerRegistry = window.Alpine?.reactive ? Alpine.reactive({}) : {};

    // Fallback API used when a picker ID isn't registered yet; coerces to empty string.
    const _nullApi = (() => {
        const noop = () => {};
        const empty = () => '';
        return {
            hex: '', formatted: '', css: '',
            h: 0, s: 0, v: 100, a: 1,
            format: 'hex', pickerMode: 'solid',
            layers: [], activeLayer: null, activeStop: null,
            activeLayerIndex: 0, activeStopIndex: 0, openStop: null,
            [Symbol.toPrimitive]: empty, toString: empty, valueOf: empty,
            addLayer: noop, duplicateLayer: noop, removeLayer: noop,
            flipLayer: noop, rotateLayer: noop,
            addStop: noop, duplicateStop: noop, deleteStop: noop,
            setGradientType: noop, applyColor: noop, grabColor: noop,
            setHue: noop, setAlpha: noop, setAlphaValue: noop,
            setColorSpace: noop, setColorValue: noop, setAngle: noop, setGradientValue: noop,
            selectStop: noop, toggleStop: noop,
            setFromString: () => false, toFormattedString: empty, toHex: empty
        };
    })();

    function createPickerState(rootEl) {
        pickerCounter++;
        const pickerUid = 'cp-' + pickerCounter;

        const state = {
            rootEl,
            pickerUid,

            // Data
            solidColor: { h: 0, s: 0, v: 100, a: 1 },
            solidFormat: 'hex',
            layers: [ makeDefaultLayer() ],
            activeLayerIndex: 0,
            activeStopIndex: 0,
            pickerMode: 'solid',
            openStop: null, // { layerIndex, stopIndex } | null

            // Tab/panel filtering. When set (via array-literal directive expression
            // on the root, e.g. `x-colorpicker="['solid', 'gradient']"`), the default
            // injected UI is filtered + reordered to match. null/empty = all panels.
            allowedPanels: null,

            // Elements that act as live labels for the current solid format (e.g. a
            // dropdown button whose text reads "Hex"/"RGB"/"HSL"/"OKLCH"). Refreshed
            // whenever the format changes via _refreshFormatLabels().
            formatLabelEls: [],
            // Elements bound to a specific format value (e.g. <li set-color-space="hex">).
            // Refreshed alongside the labels to toggle an `active` class on the current.
            formatChoiceEls: [],

            // Element registry (populated by child directive handlers)
            hiddenInput: null,
            triggerBtn: null,
            solidTemplate: null,        // <template x-colorpicker.solid>
            gradientTemplate: null,     // <template x-colorpicker.gradient>
            layerTemplate: null,        // <template x-colorpicker.layer-options>
            solidInstances: [],         // <div x-colorpicker.solid> (not template)
            gradientInstances: [],      // <div x-colorpicker.gradient> (not template)
            layersContainer: null,      // <div x-colorpicker.gradient-layers>
            gradientValueInputs: [],    // <textarea x-colorpicker.set-gradient-value>

            // Library
            libraryContainers: [],      // <div x-colorpicker.library> — every registered target (top-level tab, nested stop menus, etc.)
            libraryTemplate: null,      // <template x-colorpicker.library> — dev layout (cloned into container)
            libraryRootValue: null,     // expression from x-colorpicker.library="..." (data source)

            // Recent-list commit tracking. `_recentBaseline` is the color at the start of
            // a commit cycle (popover open, or inline picker init / last commit).
            // `_lastChangeFromLibrary` is true if the most recent user change was picking
            // a preset swatch — those don't count as "recent" even if committed.
            // `_hasUserChange` is true if any non-library user interaction has happened
            // since the baseline was set.
            _recentBaseline: null,
            _lastChangeFromLibrary: false,
            _hasUserChange: false,

            // The currently active solid-controls refs (inside Solid tab OR open-stop accordion)
            activeControls: null,
            solidTabRefs: null,

            // Reactive version counter — bumped on every state change. The API
            // getters read this to establish a reactive dependency, then compute
            // values lazily. No upfront work when nothing is bound to $colorpicker(id).
            snapshot: window.Alpine?.reactive ? Alpine.reactive({ version: 0 }) : { version: 0 },

            // ---- Active target accessors ----

            get isGradient() { return this.pickerMode === 'gradient'; },
            activeLayer() { return this.layers[this.activeLayerIndex] || this.layers[0]; },
            activeStop() {
                const layer = this.activeLayer();
                return layer.stops[this.activeStopIndex] || layer.stops[0];
            },

            get h() { return this.isGradient ? this.activeStop().color.h : this.solidColor.h; },
            set h(v) { if (this.isGradient) this.activeStop().color.h = v; else this.solidColor.h = v; },
            get s() { return this.isGradient ? this.activeStop().color.s : this.solidColor.s; },
            set s(v) { if (this.isGradient) this.activeStop().color.s = v; else this.solidColor.s = v; },
            get v() { return this.isGradient ? this.activeStop().color.v : this.solidColor.v; },
            set v(val) { if (this.isGradient) this.activeStop().color.v = val; else this.solidColor.v = val; },
            get a() { return this.isGradient ? this.activeStop().color.a : this.solidColor.a; },
            set a(v) { if (this.isGradient) this.activeStop().color.a = v; else this.solidColor.a = v; },

            get format() { return this.isGradient ? (this.activeStop().format || 'hex') : this.solidFormat; },
            set format(v) {
                if (this.isGradient) this.activeStop().format = v;
                else this.solidFormat = v;
            },

            toRgb() { return hsvToRgb(this.h, this.s, this.v); },
            toHex() { const {r,g,b} = this.toRgb(); return rgbToHex(r,g,b); },
            toFormattedString() {
                if (this.isGradient) return buildFullGradientString(this.layers);
                const {r,g,b} = this.toRgb();
                return formatColor(r, g, b, this.a, this.solidFormat);
            },
            toActiveColorString() {
                const {r,g,b} = this.toRgb();
                return formatColor(r, g, b, this.a, this.format);
            },
            toSwatchColor() {
                if (this.isGradient) return buildFullGradientString(this.layers);
                const {r,g,b} = this.toRgb();
                if (this.a < 1) return `rgba(${r},${g},${b},${this.a})`;
                return this.toHex();
            },

            // ---- Mutators ----

            setFromString(str) {
                if (typeof str !== 'string') return false;
                // Gradient input → parse into layers + activate gradient mode.
                if (/gradient\s*\(/i.test(str)) {
                    const layers = parseGradientString(str);
                    if (!layers || !layers.length) return false;
                    this.layers = layers;
                    this.activeLayerIndex = 0;
                    this.activeStopIndex = 0;
                    this.openStop = null;
                    // Seed the picker's working solid color from the first stop so
                    // syncUI / hex output / canvas reflect something coherent.
                    const firstStop = layers[0].stops[0];
                    if (firstStop) {
                        this.h = firstStop.color.h; this.s = firstStop.color.s;
                        this.v = firstStop.color.v; this.a = firstStop.color.a;
                    }
                    if (this.pickerMode !== 'gradient') this.pickerMode = 'gradient';
                    if (this.layersContainer) this.renderLayers();
                    return true;
                }
                // Solid input → existing behavior.
                const parsed = parseCssColor(str);
                if (!parsed) return false;
                const hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
                this.h = hsv.h; this.s = hsv.s; this.v = hsv.v; this.a = parsed.a;
                const fmt = detectFormat(str);
                if (fmt) this.format = fmt;
                return true;
            },

            selectStop(layerIndex, stopIndex) {
                this.activeLayerIndex = layerIndex;
                this.activeStopIndex = stopIndex;
            },

            toggleStop(layerIndex, stopIndex) {
                const same = this.openStop && this.openStop.layerIndex === layerIndex && this.openStop.stopIndex === stopIndex;
                this.openStop = same ? null : { layerIndex, stopIndex };
                this.activeLayerIndex = layerIndex;
                this.activeStopIndex = stopIndex;
                this.renderLayers();
                // Gradient swatches in the library must be disabled while a stop is open
                // (CSS gradients can't contain nested gradients as stop colors).
                this._syncStopGradientDisable();
            },

            addLayer() {
                this.layers.push(makeDefaultLayer());
                this.activeLayerIndex = this.layers.length - 1;
                this.activeStopIndex = 0;
                this.renderLayers(); this.syncToInput();
            },

            // Insert a fresh default layer relative to the given index.
            // position: 'above' inserts before `i`; 'below' (default) inserts after.
            addLayerAt(i, position) {
                if (i == null || i < 0 || i > this.layers.length) return;
                const insertAt = position === 'above' ? i : i + 1;
                this.layers.splice(insertAt, 0, makeDefaultLayer());
                this.activeLayerIndex = insertAt;
                this.activeStopIndex = 0;
                this.renderLayers(); this.syncToInput();
            },

            // Swap the layer at `i` with its neighbor. delta = -1 moves up, +1 moves down.
            // No-op at edges.
            moveLayer(i, delta) {
                const src = i;
                const dst = src + delta;
                if (src < 0 || src >= this.layers.length) return;
                if (dst < 0 || dst >= this.layers.length) return;
                const [layer] = this.layers.splice(src, 1);
                this.layers.splice(dst, 0, layer);
                // Preserve the "currently active layer" identity through the move
                if (this.activeLayerIndex === src) this.activeLayerIndex = dst;
                else if (delta > 0 && this.activeLayerIndex === dst) this.activeLayerIndex = src;
                else if (delta < 0 && this.activeLayerIndex === dst) this.activeLayerIndex = src;
                this.renderLayers(); this.syncToInput();
            },

            duplicateLayer(i) {
                const src = this.layers[i]; if (!src) return;
                this.layers.splice(i + 1, 0, {
                    type: src.type, angle: src.angle, position: { ...src.position },
                    stops: src.stops.map(s => ({ color: { ...s.color }, position: s.position, format: s.format || 'hex' }))
                });
                this.activeLayerIndex = i + 1; this.activeStopIndex = 0;
                this.renderLayers(); this.syncToInput();
            },

            removeLayer(i) {
                if (this.layers.length <= 1) return;
                this.layers.splice(i, 1);
                if (this.activeLayerIndex >= this.layers.length) this.activeLayerIndex = this.layers.length - 1;
                this.activeStopIndex = 0;
                this.renderLayers(); this.syncToInput();
            },

            flipLayer(i) {
                const layer = this.layers[i]; if (!layer) return;
                for (const stop of layer.stops) stop.position = 100 - stop.position;
                this.renderLayers(); this.syncToInput();
            },

            rotateLayer(i) {
                const layer = this.layers[i]; if (!layer) return;
                layer.angle = (layer.angle + 90) % 360;
                this.renderLayers(); this.syncToInput();
            },

            setGradientType(i, type) {
                const layer = this.layers[i]; if (!layer) return;
                if (!GRADIENT_TYPES.includes(type)) return;
                layer.type = type;
                this.renderLayers(); this.syncToInput();
            },

            addStop(layerIndex, position) {
                const layer = this.layers[layerIndex]; if (!layer) return;
                const sorted = layer.stops.slice().sort((a,b) => a.position - b.position);
                let before = sorted[0], after = sorted[sorted.length - 1];
                for (let k = 0; k < sorted.length - 1; k++) {
                    if (sorted[k].position <= position && sorted[k+1].position >= position) {
                        before = sorted[k]; after = sorted[k+1]; break;
                    }
                }
                const range = after.position - before.position;
                const t = range === 0 ? 0.5 : (position - before.position) / range;
                layer.stops.push({
                    color: {
                        h: before.color.h + (after.color.h - before.color.h) * t,
                        s: before.color.s + (after.color.s - before.color.s) * t,
                        v: before.color.v + (after.color.v - before.color.v) * t,
                        a: before.color.a + (after.color.a - before.color.a) * t,
                    },
                    position, format: before.format || 'hex'
                });
                this.activeLayerIndex = layerIndex;
                this.activeStopIndex = layer.stops.length - 1;
                this.renderLayers(); this.syncToInput();
            },

            duplicateStop(layerIndex, stopIndex) {
                const layer = this.layers[layerIndex]; if (!layer) return;
                const src = layer.stops[stopIndex]; if (!src) return;
                layer.stops.push({ color: { ...src.color }, position: Math.min(100, src.position + 5), format: src.format || 'hex' });
                this.activeLayerIndex = layerIndex;
                this.activeStopIndex = layer.stops.length - 1;
                this.renderLayers(); this.syncToInput();
            },

            deleteStop(layerIndex, stopIndex) {
                const layer = this.layers[layerIndex]; if (!layer) return;
                if (layer.stops.length <= 2) return;
                layer.stops.splice(stopIndex, 1);
                if (this.activeLayerIndex === layerIndex && this.activeStopIndex >= layer.stops.length)
                    this.activeStopIndex = layer.stops.length - 1;
                this.renderLayers(); this.syncToInput();
            },

            applyColor(str) {
                // Pure setter — Recent-list commits happen at the picker-close boundary
                // (popover close / inline focusout), not on every call.
                if (this.setFromString(str)) {
                    this.syncUI();
                    this.syncToInput();
                    if (this.isGradient) this._refreshActiveStopVisuals();
                }
            },

            // Toggle `.active` on library swatches whose canonical key matches the
            // picker's current color. Gradients compare as their full CSS string;
            // solids compare as 8-digit hex. Runs across every registered library
            // container (tab + any nested containers such as stop context menus).
            _updateActiveSwatches() {
                if (!this.libraryContainers.length) return;
                const current = this.isGradient
                    ? this.toFormattedString()
                    : (() => {
                        const {r,g,b} = this.toRgb();
                        return rgbToHex8(r, g, b, this.a);
                    })();
                const key = _swatchKeyOf(current);
                for (const c of this.libraryContainers) {
                    if (!c.isConnected) continue;
                    const nodes = c.querySelectorAll('[data-cp-key]');
                    for (const n of nodes) n.classList.toggle('active', key != null && n.getAttribute('data-cp-key') === key);
                }
                this._syncStopGradientDisable();
            },

            // Gradient-valued library swatches must be un-pickable when the click would
            // try to apply that gradient as a gradient-stop color (CSS doesn't allow
            // nested gradients in stop positions). That's the case when:
            //   • a stop accordion is currently open (openStop set), OR
            //   • the library container itself is nested inside a stop-context-menu —
            //     every click in such a menu targets the right-clicked stop's color.
            // Dev CSS styles [disabled] on apply-color elements; the click handler
            // also short-circuits as belt-and-braces.
            _syncStopGradientDisable() {
                const stopIsOpen = !!this.openStop;
                for (const c of this.libraryContainers) {
                    if (!c.isConnected) continue;
                    const containerInStopMenu = !!c.closest('menu[id^="stop-context-menu"]');
                    const shouldDisable = stopIsOpen || containerInStopMenu;
                    const gradNodes = c.querySelectorAll('[data-cp-key]');
                    for (const n of gradNodes) {
                        const k = n.getAttribute('data-cp-key') || '';
                        const isGradient = k.includes('gradient(');
                        if (!isGradient) continue;
                        if (shouldDisable) n.setAttribute('disabled', '');
                        else n.removeAttribute('disabled');
                    }
                }
            },

            // ---- Recent-list commit cycle ----
            //
            // Rules:
            //   • Popover pickers commit on toggle→closed.
            //   • Inline pickers commit on focusout past the rootEl.
            //   • A commit pushes the current color to Recent IFF the user made a
            //     non-library change since the last baseline and the color actually differs.
            //   • Gradient mode never commits (stops are part of a gradient, not standalone).
            //   • Programmatic api.applyColor calls don't mark user changes — only UI paths do.

            _startCommitCycle() {
                this._recentBaseline = this._currentCommitValue();
                this._lastChangeFromLibrary = false;
                this._hasUserChange = false;
            },

            _markUserChange(fromLibrary) {
                this._hasUserChange = true;
                this._lastChangeFromLibrary = !!fromLibrary;
            },

            _currentCommitValue() {
                // Solid: canonical hex (format-independent). Gradient: full CSS string.
                try { return this.isGradient ? this.toFormattedString() : this.toHex(); }
                catch { return null; }
            },

            _tryCommitRecent() {
                if (!this._hasUserChange) return;                 // no interaction since baseline
                if (this._lastChangeFromLibrary) return;          // library picks don't count
                const current = this._currentCommitValue();
                if (!current) return;
                if (current === this._recentBaseline) return;     // no actual change
                pushRecent(current);
                // Start a fresh cycle so repeated inline commits behave correctly
                this._startCommitCycle();
            },

            // Shared-picker write-back: when a swatch with x-model triggered this picker,
            // push the current color through the swatch's model setter on commit. Unlike
            // Recent, this runs even when the change came from a library click — the user
            // clicked a library swatch intending to assign that color to their field.
            _commitToTrigger() {
                const trigger = this.triggerBtn;
                if (!trigger || typeof trigger._cpModelSetter !== 'function') return;
                if (!this._hasUserChange) return; // nothing to persist
                const value = this._currentCommitValue();
                if (value != null) trigger._cpModelSetter(value);
            },

            async grabColor() {
                if (!window.EyeDropper) return;
                try {
                    const result = await new EyeDropper().open();
                    // Eyedropper is a single-color operation — route the result
                    // to Solid mode and surface the solid controls. Mark as a
                    // non-library user change; the usual commit boundary decides
                    // whether it lands in Recent (user may tweak before closing).
                    this._switchToSolidMode();
                    this._markUserChange(false);
                    this.applyColor(result.sRGBHex);
                } catch (e) { /* user cancelled */ }
            },

            // Force the picker into solid mode and activate solid controls.
            // Also updates Alpine `tab` data (if the dev uses a tab-driven layout).
            _switchToSolidMode() {
                this.pickerMode = 'solid';
                this.openStop = null;
                const rootStack = this.rootEl._x_dataStack;
                const autoStack = this._autoTabScope?._x_dataStack;
                if (rootStack && rootStack[0] && 'tab' in rootStack[0]) rootStack[0].tab = 'solid';
                else if (autoStack && autoStack[0] && 'tab' in autoStack[0]) autoStack[0].tab = 'solid';
                if (this.solidTabRefs) this._activateControls(this.solidTabRefs);
                if (this.layersContainer) this.renderLayers();
            },

            // Switch picker mode without touching the dev's `tab` Alpine data.
            // Used by library-tab applies — the user is browsing swatches and
            // shouldn't be flipped off the Library tab when they pick one.
            _setPickerMode(mode) {
                if (this.pickerMode === mode) return;
                this.pickerMode = mode;
                this.openStop = null;
                if (mode === 'solid' && this.solidTabRefs) this._activateControls(this.solidTabRefs);
                if (mode === 'gradient') this._activateControls(null);
                if (this.layersContainer) this.renderLayers();
            },

            // Setter methods (mirror .set-* modifiers)
            setHue(v) {
                this.h = v;
                this.drawCanvas(); this.updateCanvasMarker();
                this.syncToInput(); this.updateColorInput();
                if (this.isGradient) this._refreshActiveStopVisuals();
            },
            setAlpha(v) {
                this.a = Math.max(0, Math.min(1, v));
                this.syncToInput(); this.updateColorInput(); this.updateAlphaInput();
                if (this.isGradient) this._refreshActiveStopVisuals();
            },
            setAlphaValue(percent) { this.setAlpha(percent / 100); },
            setColorSpace(fmt) {
                if (!FORMATS.includes(fmt)) return;
                this.format = fmt;
                this.updateColorInput();
                this._refreshFormatLabels();
            },

            // Display label for each format (e.g. button text in a custom format dropdown)
            _formatLabel(fmt) {
                switch ((fmt || '').toLowerCase()) {
                    case 'hex': return 'Hex';
                    case 'rgb': return 'RGB';
                    case 'hsl': return 'HSL';
                    case 'oklch': return 'OKLCH';
                    default: return fmt || '';
                }
            },

            // Sync any registered format label elements to the current format and
            // toggle an `active` class on each format-choice element so devs can
            // style the active option without writing reactive bindings.
            _refreshFormatLabels() {
                const current = this.format;
                const label = this._formatLabel(current);
                for (const el of this.formatLabelEls) {
                    if (!el || !el.isConnected) continue;
                    if (el.textContent !== label) el.textContent = label;
                }
                for (const { el, fmt } of this.formatChoiceEls) {
                    if (!el || !el.isConnected) continue;
                    el.classList.toggle('active', fmt === current);
                }
            },
            setColorValue(str) {
                if (this.setFromString(str)) {
                    this.drawCanvas(); this.updateCanvasMarker(); this.updateSliders();
                    this.updateAlphaInput(); this.syncToInput();
                    if (this.isGradient) this._refreshActiveStopVisuals();
                }
            },
            setAngle(i, degrees) {
                const layer = this.layers[i]; if (!layer) return;
                layer.angle = ((degrees % 360) + 360) % 360;
                this._refreshLayerVisuals(i);
                this.syncToInput();
            },
            setGradientValue(cssString) {
                // Edits don't parse back into layers; plugin writes the CSS var for the swatch.
                if (this.triggerBtn) this.triggerBtn.style.setProperty('--color-picker-swatch', cssString);
            },

            // ---- Sync / render ----

            syncToInput() {
                const swatchVal = this.toSwatchColor();
                if (this.hiddenInput) {
                    // Native <input type="color"> only accepts #rrggbb; everything
                    // else (synthesized type=hidden, dev-supplied type=hidden) gets
                    // the full CSS string — solid color or gradient — so gradients
                    // and non-hex formats round-trip without lossy conversion.
                    const isNativeColorInput = this.hiddenInput.type === 'color';
                    this.hiddenInput.value = isNativeColorInput ? this.toHex() : swatchVal;
                    this.hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
                    this.hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (this.triggerBtn) this.triggerBtn.style.setProperty('--color-picker-swatch', swatchVal);
                this.updateGradientValue();
                // Reflect current color in the library: any swatch whose canonical key
                // matches gets an `.active` class, all others lose it.
                this._updateActiveSwatches();
                // Refresh any custom format labels / choice highlights — covers paths
                // where format changes implicitly (setFromString parsing a new format).
                this._refreshFormatLabels();

                // Bump reactive version — any $colorpicker(id).* reader re-runs.
                // No eager computation of hex/css/etc. unless somebody is actually bound to them.
                this.snapshot.version++;
            },

            syncUI() {
                this.drawCanvas();
                this.updateSliders();
                this.updateColorInput();
                this.updateAlphaInput();
                this.updateCanvasMarker();
            },

            drawCanvas() {
                const canvas = this.activeControls?.canvas;
                if (!canvas) return;
                const rect = canvas.getBoundingClientRect();
                if (rect.width <= 0) return; // not visible yet; ResizeObserver will redraw when it gains size
                let dimsChanged = false;
                if (canvas.width !== rect.width)  { canvas.width  = rect.width;  dimsChanged = true; }
                if (canvas.height !== rect.height) { canvas.height = rect.height; dimsChanged = true; }
                // Skip repaint if hue unchanged and dimensions unchanged (setting canvas.* dims clears the pixels)
                if (!dimsChanged && canvas._cpLastHue === this.h) return;
                drawSvCanvas(canvas, this.h);
                canvas._cpLastHue = this.h;
            },

            updateSliders() {
                const ac = this.activeControls; if (!ac) return;
                if (ac.hueSlider && document.activeElement !== ac.hueSlider) ac.hueSlider.value = this.h;
                if (ac.alphaSlider && document.activeElement !== ac.alphaSlider) {
                    ac.alphaSlider.value = Math.round(this.a * 100);
                    const {r,g,b} = this.toRgb();
                    ac.alphaSlider.style.setProperty('--color-picker-alpha', `rgb(${r},${g},${b})`);
                }
            },

            updateCanvasMarker() {
                const reticle = this.activeControls?.reticle; if (!reticle) return;
                reticle.style.left = this.s + '%';
                reticle.style.top = (100 - this.v) + '%';
            },

            updateColorInput() {
                const ac = this.activeControls; if (!ac) return;
                if (ac.colorInput && document.activeElement !== ac.colorInput) ac.colorInput.value = this.toActiveColorString();
                if (ac.formatSelect && ac.formatSelect.value !== this.format) ac.formatSelect.value = this.format;
            },

            updateAlphaInput() {
                const ac = this.activeControls; if (!ac) return;
                if (ac.alphaInput && document.activeElement !== ac.alphaInput) ac.alphaInput.value = Math.round(this.a * 100);
            },

            updateGradientValue() {
                for (const ta of this.gradientValueInputs) {
                    if (document.activeElement === ta) continue;
                    ta.value = buildFullGradientString(this.layers);
                }
            },

            // ---- Library rendering ----
            //
            // Templates are nested in natural HTML hierarchy (x-for style):
            //   <template x-colorpicker.library>
            //     <template x-colorpicker.library-group>          <!-- scope: group -->
            //       <template x-colorpicker.library-palette>     <!-- scope: palette -->
            //         <template x-colorpicker.library-swatch>    <!-- scope: swatch -->
            //         </template>
            //       </template>
            //     </template>
            //   </template>
            //
            // Each inner <template> is replaced in-place by clones (siblings before it, then removed).
            // Data shape after normalization: [{ name?, colors?: Swatch[], palettes?: Palette[] }].
            // If a group has only `colors` (flat, e.g. Recent), it's auto-wrapped as a single
            // unnamed palette so nested templates still work uniformly.

            renderLibrary() {
                if (this._libraryEffectBound) return;
                this._libraryEffectBound = true;
                if (!this.libraryContainers.length) return;
                // All registered containers share the same data source / render key. Use
                // the first for any Alpine scope evaluation that needs an element.
                const evalHost = this.libraryContainers[0];

                if (this.libraryRootValue && window.Alpine?.effect && window.Alpine?.evaluateLater) {
                    // Explicit expression — bypass discovery, re-render reactively when deps change
                    const evalFn = Alpine.evaluateLater(evalHost, this.libraryRootValue);
                    Alpine.effect(() => {
                        evalFn(v => { this._libraryResolvedData = v; this._doRenderLibrary(); });
                    });
                } else if (window.Alpine?.effect) {
                    // Zero-config — scan `$x.manifest.data` for entries flagged with a
                    // `colorpicker:` key (mirroring how `locales:`, `appwriteTableId`, etc.
                    // self-identify their plugin). Each flagged entry is loaded normally
                    // by the data plugin; we collect the resulting `$x.<name>` values and
                    // merge them into the library in declaration order.
                    //
                    // Multiple sources are supported — split your default-palette overrides
                    // (`_tailwind`, `_ios`) and your custom palettes across as many files
                    // as you like. Order in `manifest.data` determines render order.
                    //
                    // Everything happens synchronously inside the effect so Alpine tracks
                    // all reactive deps ($locale, $x.manifest, each $x.<name>) and re-runs
                    // the full pass on any change. Evaluate against document.body so $x
                    // magic is always in scope (the container may be detached/popover
                    // content without its own scope chain).
                    const evalCtx = document.body;

                    // Manifest's data plugin REPLACES the $x.<source> proxy reference on load
                    // rather than mutating in place. Alpine.effect can't catch that change via
                    // property tracking, so we pair it with a short-lived poller that RE-READS
                    // discovery until the data is loaded. We only actually re-render when the
                    // serialized content has changed since the last render — otherwise each
                    // poll tick would tear down and rebuild the whole library, thrashing the
                    // DOM (and invalidating x-dropdown.context menu id lookups mid-flight).
                    const keyOf = (names, collected) => {
                        // Include the Recent list in the key so additions/removals trigger a
                        // re-render. Reading _recentStore.list inside the Alpine.effect also
                        // establishes reactivity on it, so cookie mutations (pushRecent /
                        // removeRecent) fire the effect and change the key.
                        const recentKey = _recentStore.list.slice(0, _recentMax).join(',');
                        try { return recentKey + '#' + names.join('|') + '::' + JSON.stringify(collected); }
                        catch { return recentKey + '#' + names.join('|') + '::[unserializable]'; }
                    };
                    const readSources = () => {
                        // Discover names by scanning manifest.data for entries with a
                        // `colorpicker` key. The key may hold a path string or a locale
                        // map — the data plugin handles loading either shape; we just
                        // need the set of names whose loaded data should feed the library.
                        let dataMap = null;
                        try { dataMap = Alpine.evaluate(evalCtx, '$x && $x.manifest && $x.manifest.data'); } catch {}
                        const names = [];
                        if (dataMap && typeof dataMap === 'object') {
                            for (const name of Object.keys(dataMap)) {
                                if (name.startsWith('$') || name.startsWith('_')) continue;
                                if (name === 'valueOf' || name === 'toString' || name === 'contentType') continue;
                                const entry = dataMap[name];
                                if (entry && typeof entry === 'object' && !Array.isArray(entry)
                                    && entry.colorpicker !== undefined) {
                                    names.push(name);
                                }
                            }
                        }
                        const collected = names.map(name => {
                            try { return Alpine.evaluate(evalCtx, '$x.' + name); } catch { return null; }
                        });
                        const ready = names.length === 0 || collected.every(src => {
                            if (!src || typeof src !== 'object') return false;
                            return Object.keys(src).some(k => !k.startsWith('$')
                                && !k.startsWith('_')
                                && k !== 'contentType'
                                && k !== 'valueOf' && k !== 'toString');
                        });
                        return { names, collected, ready };
                    };
                    const runDiscovery = () => {
                        const { names, collected, ready } = readSources();
                        const key = keyOf(names, collected);
                        if (key !== this._libraryDiscoveredKey) {
                            this._libraryDiscoveredKey = key;
                            this._libraryDiscoveredData = collected;
                            this._doRenderLibrary();
                        }
                        return ready;
                    };

                    // Reactive deps trigger re-runs on locale switch / manifest load.
                    Alpine.effect(() => {
                        try { Alpine.evaluate(evalCtx, '$locale && $locale.current'); } catch {}
                        try { Alpine.evaluate(evalCtx, '$x && $x.manifest && $x.manifest._loadedFrom'); } catch {}
                        runDiscovery();
                        // Kick the poller only until data is ready — it re-checks every 150ms
                        // but skips actual re-render when the content is unchanged.
                        if (!this._libraryPollTimer) {
                            let attempts = 0;
                            this._libraryPollTimer = setInterval(() => {
                                attempts++;
                                if (runDiscovery() || attempts > 80) {  // max ~12s
                                    clearInterval(this._libraryPollTimer);
                                    this._libraryPollTimer = null;
                                }
                            }, 150);
                        }
                    });
                } else {
                    this._doRenderLibrary();
                }
            },

            _resolveLibraryGroups() {
                let groups;
                if (this.libraryRootValue) {
                    let data = this._libraryResolvedData;
                    if (data == null
                        || (Array.isArray(data) && data.length === 0)
                        || (typeof data === 'object' && !Array.isArray(data) && _cleanLibraryEntries(data).length === 0)) {
                        data = buildDefaultLibrary();
                    }
                    groups = normalizeLibraryInput(data);
                    const totalSwatches = groups.reduce((n, g) => n + (g.colors?.length || 0)
                        + (g.palettes?.reduce((m, p) => m + (p.colors?.length || 0), 0) || 0), 0);
                    if (totalSwatches === 0) groups = normalizeLibraryInput(buildDefaultLibrary());
                } else {
                    groups = composeLibraryFromSources(this._libraryDiscoveredData || []);
                }
                // Resolve any `$x.<path>` or `${...}` template-literal references in
                // group / palette / swatch names, so a single colorpicker file can
                // chain into a separate localization data source without dev-side
                // template tweaks. Reactive reads inside `Alpine.evaluate` register
                // deps on the surrounding render effect → locale switches re-render.
                return _resolveLibraryRefs(groups);
            },

            // Render ONE container (used when a new container registers post-mount
            // — e.g. a gradient layer clone's inline library div). Avoids tearing
            // down every other container's x-dropdown.context init timers.
            _renderIntoContainer(container) {
                if (!container || !container.isConnected) return;
                const groups = this._resolveLibraryGroups();
                const layoutTpl = this.libraryTemplate || _defaultLibraryLayoutTpl;
                container.innerHTML = '';
                container.appendChild(layoutTpl.content.cloneNode(true));
                const groupTpl = container.querySelector('template[x-colorpicker\\.library-group]');
                if (groupTpl) {
                    const parent = groupTpl.parentNode;
                    for (const g of groups) parent.insertBefore(renderLibraryGroup(groupTpl, g), groupTpl);
                    groupTpl.remove();
                } else {
                    for (const g of groups) container.appendChild(renderDefaultGroup(g));
                }
                if (window.Alpine?.initTree) Alpine.initTree(container);
                // Newly-rendered swatches need active + gradient-disable state applied.
                this._updateActiveSwatches();
            },

            _doRenderLibrary() {
                if (!this.libraryContainers.length) return;
                // Prune disconnected containers (removed by gradient layer re-render etc.)
                this.libraryContainers = this.libraryContainers.filter(c => c.isConnected);
                for (const container of this.libraryContainers) this._renderIntoContainer(container);
                // Active-class pass across all rendered swatches
                this._updateActiveSwatches();
            },

            _activateControls(refs) {
                this.activeControls = refs || null;
                if (refs) this.syncUI();
            },

            _refreshLayerVisuals(li) {
                const clone = this._getLayerClone(li);
                if (!clone) return;
                const bar = findInClone(clone, 'layer-stops-bar');
                if (bar) this._updateStopBarPreview(bar, this.layers[li]);
            },

            _refreshActiveStopVisuals() {
                const clone = this._getLayerClone(this.activeLayerIndex);
                if (!clone) return;
                const bar = findInClone(clone, 'layer-stops-bar');
                if (bar) this._updateStopBarPreview(bar, this.activeLayer());
                const handle = bar?.querySelectorAll('[data-cp-stop-handle]')[this.activeStopIndex];
                if (handle) handle.style.backgroundColor = colorToRgba(this.activeStop().color);
            },

            _updateStopBarPreview(barEl, layer) {
                const preview = layer.stops.slice().sort((a,b) => a.position - b.position)
                    .map(s => `${colorToRgba(s.color)} ${s.position}%`).join(', ');
                barEl.style.background = `linear-gradient(to right, ${preview})`;
            },

            _getLayerClone(li) {
                if (!this.layersContainer) return null;
                return this.layersContainer.querySelectorAll(':scope > [data-cp-layer-clone]')[li] || null;
            },

            // ---- Layer rendering ----

            renderLayers() {
                if (!this.layersContainer) return;

                // Clamp openStop
                if (this.openStop) {
                    const L = this.layers[this.openStop.layerIndex];
                    if (!L || !L.stops[this.openStop.stopIndex]) this.openStop = null;
                }

                // Clear existing clones
                this.layersContainer.querySelectorAll(':scope > [data-cp-layer-clone]').forEach(el => el.remove());

                // Get or synthesize layer template (parsed ONCE, cloned per layer)
                const layerTpl = this.layerTemplate || _defaultLayerTpl;

                let pendingActivation = null;

                this.layers.forEach((layer, li) => {
                    const frag = layerTpl.content.cloneNode(true);
                    const root = frag.firstElementChild;
                    if (!root) return;

                    root.setAttribute('data-cp-layer-clone', '');
                    root.setAttribute('data-gradient-type', layer.type);
                    root._cpLayerIndex = li;

                    // Expose the layer's position + type to the clone's Alpine scope so
                    // devs can bind classes/attributes reactively. Available in scope:
                    //   layerType   — 'linear' | 'radial' | 'conic'
                    //   layerIndex  — 0-based position of this layer
                    //   layerCount  — total number of layers in the picker
                    // Examples:
                    //   :class="'layer-type-' + layerType"
                    //   :disabled="layerIndex === 0"               (Move Up)
                    //   :disabled="layerIndex === layerCount - 1"  (Move Down)
                    //   :disabled="layerCount === 1"               (Remove)
                    root.setAttribute('x-data', '{ '
                        + 'layerType: ' + JSON.stringify(layer.type) + ', '
                        + 'layerIndex: ' + li + ', '
                        + 'layerCount: ' + this.layers.length
                        + ' }');

                    // Uniquify x-dropdown / x-dropdown.context / x-dropdown.hover IDs
                    // within this clone so per-layer dropdowns don't collide.
                    uniquifyDropdownIdsIn(root, this.pickerUid + '-layer-' + li);

                    // Render stops bar content
                    const bar = findInClone(root, 'layer-stops-bar');
                    if (bar) this._renderStopBar(bar, layer, li);

                    // Set initial angle input value
                    const angleInput = findInClone(root, 'set-angle');
                    if (angleInput) angleInput.value = layer.angle;

                    // Populate accordion solid panel if this is the open stop's layer
                    const nestedSolidInstance = findInClone(root, 'solid');
                    if (nestedSolidInstance && this.openStop && this.openStop.layerIndex === li) {
                        const refs = this._mountSolidInstance(nestedSolidInstance);
                        if (refs) pendingActivation = refs;
                    }

                    this.layersContainer.appendChild(root);

                    // Let Alpine/Manifest process the clone (x-dropdown, x-icon, and nested x-colorpicker directives)
                    if (window.Alpine?.initTree) {
                        requestAnimationFrame(() => Alpine.initTree(root));
                    }
                });

                if (pendingActivation) this._activateControls(pendingActivation);
                else if (this.isGradient) this._activateControls(null);
            },

            _renderStopBar(barEl, layer, layerIndex) {
                barEl.innerHTML = '';
                this._updateStopBarPreview(barEl, layer);

                // Drop-to-add-stop on bar click (non-handle clicks)
                barEl.onclick = (e) => {
                    if (e.target.hasAttribute('data-cp-stop-handle')) return;
                    const rect = barEl.getBoundingClientRect();
                    this.addStop(layerIndex, Math.round(((e.clientX - rect.left) / rect.width) * 100));
                };

                layer.stops.forEach((stop, si) => {
                    const handle = document.createElement('div');
                    handle.className = 'stop-handle';
                    handle.setAttribute('data-cp-stop-handle', '');
                    handle.style.left = stop.position + '%';
                    handle.style.backgroundColor = colorToRgba(stop.color);
                    // .active reflects whether this stop's accordion is currently open
                    if (this.openStop && this.openStop.layerIndex === layerIndex && this.openStop.stopIndex === si) {
                        handle.classList.add('active');
                    }

                    let dragging = false, startX = 0, moved = false, cachedBarRect = null;
                    const self = this;
                    const applyDrag = (e) => {
                        if (!cachedBarRect) cachedBarRect = barEl.getBoundingClientRect();
                        const rect = cachedBarRect;
                        stop.position = Math.max(0, Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
                        handle.style.left = stop.position + '%';
                        self._updateStopBarPreview(barEl, layer);
                        self.syncToInput();
                    };
                    const throttledDrag = rafThrottle(applyDrag);
                    handle.addEventListener('pointerdown', (e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        self.selectStop(layerIndex, si);
                        // .active is set by the re-render after toggleStop;
                        // don't preemptively toggle here (would be wrong for drag-without-toggle).
                        dragging = true; moved = false; startX = e.clientX;
                        cachedBarRect = barEl.getBoundingClientRect();
                        handle.setPointerCapture(e.pointerId);
                    });
                    handle.addEventListener('pointermove', (e) => {
                        if (!dragging) return;
                        if (Math.abs(e.clientX - startX) > 3) moved = true;
                        if (moved) throttledDrag(e);
                    });
                    handle.addEventListener('pointerup', () => {
                        // Only toggle/cleanup if we had a valid left-click drag session.
                        // Right-click never sets `dragging=true` (pointerdown bails for button!==0),
                        // so this pointerup would otherwise still call toggleStop() and
                        // destroy the layer clone — killing the context menu that just opened.
                        if (!dragging) return;
                        const wasMoved = moved;
                        dragging = false; moved = false; cachedBarRect = null;
                        if (!wasMoved) self.toggleStop(layerIndex, si);
                    });
                    barEl.appendChild(handle);
                });
            },

            // ---- Solid instance mounting ----

            _mountSolidInstance(containerEl) {
                if (!containerEl) return null;
                containerEl.innerHTML = '';
                const source = this.solidTemplate || _defaultSolidTpl;
                const frag = source.content.cloneNode(true);
                // Uniquify any x-dropdown menu ids inside the cloned solid panel
                // (e.g. the `color-space-menu` from the default template) so two
                // pickers on the same page don't share the same popover element.
                uniquifyDropdownIdsIn(frag, this.pickerUid + '-solid');
                containerEl.appendChild(frag);

                const refs = this._collectSolidRefs(containerEl);
                this._wireSolidControls(refs);

                // Let Alpine process any x-* directives in the mounted content
                if (window.Alpine?.initTree) {
                    requestAnimationFrame(() => Alpine.initTree(containerEl));
                }

                return refs;
            },

            // Mount the full gradient panel into an instance container.
            // Uses <template x-colorpicker.gradient> if provided, otherwise the default.
            _mountGradientInstance(containerEl) {
                if (!containerEl) return;
                containerEl.innerHTML = '';
                const source = this.gradientTemplate || _defaultGradientTpl;
                const frag = source.content.cloneNode(true);
                containerEl.appendChild(frag);

                // Alpine processes the inner x-colorpicker.* directives (add-layer,
                // gradient-layers, layer-options template, set-gradient-value) which
                // register with THIS state via ancestor traversal.
                if (window.Alpine?.initTree) Alpine.initTree(containerEl);
            },

            _collectSolidRefs(containerEl) {
                return {
                    wrapper: containerEl.querySelector('.canvas-wrapper')
                             || findInClone(containerEl, 'set-canvas')?.parentElement,
                    canvas: findInClone(containerEl, 'set-canvas'),
                    reticle: containerEl.querySelector('.color-reticle'),
                    hueSlider: findInClone(containerEl, 'set-hue'),
                    alphaSlider: findInClone(containerEl, 'set-alpha'),
                    colorInput: findInClone(containerEl, 'set-color-value'),
                    alphaInput: findInClone(containerEl, 'set-alpha-value'),
                    formatSelect: findInClone(containerEl, 'set-color-space'),
                };
            },

            _wireSolidControls(refs) {
                const self = this;

                // Canvas pointer + resize-driven redraw
                if (refs.canvas && refs.wrapper) {
                    let dragging = false;
                    let cachedRect = null;
                    const pick = (e) => {
                        // Cache the rect while dragging; invalidated on pointerdown
                        if (!cachedRect) cachedRect = refs.canvas.getBoundingClientRect();
                        const rect = cachedRect;
                        self.s = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
                        self.v = Math.max(0, Math.min(100, (1 - (e.clientY - rect.top) / rect.height) * 100));
                        self.syncToInput(); self.updateSliders(); self.updateColorInput(); self.updateCanvasMarker();
                        if (self.isGradient) self._refreshActiveStopVisuals();
                    };
                    const throttledPick = rafThrottle(pick);
                    refs.wrapper.addEventListener('pointerdown', (e) => {
                        dragging = true;
                        cachedRect = refs.canvas.getBoundingClientRect();
                        refs.wrapper.setPointerCapture(e.pointerId);
                        self._markUserChange(false);
                        pick(e); // immediate on first click (not throttled)
                    });
                    refs.wrapper.addEventListener('pointermove', (e) => { if (dragging) throttledPick(e); });
                    refs.wrapper.addEventListener('pointerup', () => { dragging = false; cachedRect = null; });

                    const ro = new ResizeObserver(() => {
                        if (self.activeControls?.canvas !== refs.canvas) return;
                        const r = refs.canvas.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) { self.drawCanvas(); self.updateCanvasMarker(); }
                    });
                    ro.observe(refs.canvas);
                }

                if (refs.hueSlider) {
                    refs.hueSlider.min = 0; refs.hueSlider.max = 360; refs.hueSlider.step = 1;
                    refs.hueSlider.addEventListener('input', () => {
                        self._markUserChange(false);
                        self.setHue(parseFloat(refs.hueSlider.value));
                    });
                }

                if (refs.alphaSlider) {
                    refs.alphaSlider.min = 0; refs.alphaSlider.max = 100; refs.alphaSlider.step = 1;
                    refs.alphaSlider.addEventListener('input', () => {
                        self._markUserChange(false);
                        self.setAlpha(parseFloat(refs.alphaSlider.value) / 100);
                    });
                }

                if (refs.colorInput) {
                    refs.colorInput.addEventListener('input', () => {
                        self._markUserChange(false);
                        self.setColorValue(refs.colorInput.value);
                    });
                    refs.colorInput.addEventListener('blur', () => { refs.colorInput.value = self.toActiveColorString(); });
                }

                if (refs.alphaInput) {
                    refs.alphaInput.addEventListener('input', () => {
                        const v = parseFloat(refs.alphaInput.value);
                        if (!isNaN(v)) {
                            self._markUserChange(false);
                            self.setAlphaValue(v);
                        }
                    });
                }

                if (refs.formatSelect) {
                    refs.formatSelect.addEventListener('change', () => self.setColorSpace(refs.formatSelect.value));
                }
            },

            // ---- Picker mount (after all children registered) ----

            mount() {
                // Tier 2: if the container has no declared UI (templates are inert overrides),
                // inject the full default UI. Templates alone don't count as "declared UI".
                const noDeclared = !this.solidTemplate && !this.layerTemplate && !this.gradientTemplate
                    && this.solidInstances.length === 0 && this.gradientInstances.length === 0
                    && !this.layersContainer && this.gradientValueInputs.length === 0
                    && !this.libraryContainers.length;
                const hasNonTemplateChildren = [...this.rootEl.children].some(c => c.tagName !== 'TEMPLATE');
                if (noDeclared && !hasNonTemplateChildren) {
                    this._injectDefaultUI();
                }

                // Auto-popovers register their picker state BEFORE the swatch hook gets
                // a chance to set `x-dropdown` on the trigger element, so the early
                // triggerBtn lookup misses. By mount-time (setTimeout 0) the swatch
                // wiring has finished, so re-query if we don't have one yet.
                if (!this.triggerBtn && this.rootEl.id) {
                    this.triggerBtn = document.querySelector(`[x-dropdown="${this.rootEl.id}"]`);
                }

                // Initialize the picker state from whatever source has a real value.
                // Resolution priority matches the retarget flow on swatch-click so the
                // picker's reactive value reads (`$colorpicker(id)`, .hex, .css, etc.)
                // are correct from first paint — not just after the user opens the menu.
                //   1. trigger swatch's x-model getter
                //   2. trigger swatch's paired hidden input (form-participation flow)
                //   3. trigger swatch's `value` attribute
                //   4. picker container's own hidden input child
                //   5. fallback '#000000'
                let initVal = '';
                const tb = this.triggerBtn;
                if (tb) {
                    if (tb._cpModelGetter) {
                        tb._cpModelGetter(v => { if (typeof v === 'string' && v.length) initVal = v; });
                    }
                    if (!initVal && tb._cpHiddenInput && tb._cpHiddenInput.value) initVal = tb._cpHiddenInput.value;
                    if (!initVal && tb.getAttribute('value')) initVal = tb.getAttribute('value');
                }
                if (!initVal && this.hiddenInput) initVal = this.hiddenInput.value;
                this.setFromString(initVal || '#000000');

                // Seed trigger swatch CSS var so the border-color derivation paints
                // correctly before any interaction.
                if (this.triggerBtn) this.triggerBtn.style.setProperty('--color-picker-swatch', this.toSwatchColor());

                // Mount all solid-panel instances (Solid tab + any others)
                let firstSolidRefs = null;
                for (const inst of this.solidInstances) {
                    const refs = this._mountSolidInstance(inst);
                    if (refs && !firstSolidRefs) firstSolidRefs = refs;
                }
                this.solidTabRefs = firstSolidRefs;

                // Mount all gradient-panel instances (the full gradient panel).
                // This populates them with the gradient template (or default), which in turn
                // registers gradient-layers / layer-options / set-gradient-value with this state.
                for (const inst of this.gradientInstances) this._mountGradientInstance(inst);

                // Render gradient layers (only if a container is declared)
                if (this.layersContainer) this.renderLayers();

                // Initial mode based on Alpine `tab` data, if present
                this._syncPickerModeFromTab();

                // Activate controls based on mode
                if (!this.isGradient) this._activateControls(this.solidTabRefs);

                // Wire click-based tab watcher (root + auto-injected wrapper)
                this.rootEl.addEventListener('click', () => {
                    requestAnimationFrame(() => this._syncPickerModeFromTab());
                });

                // Initial sync
                this.syncToInput();

                // Render the library — _doRenderLibrary clones the (optional) library template
                // into the container and expands nested group/palette/swatch templates in-place.
                if (this.libraryContainers.length) this.renderLibrary();

                // ---- Recent-list commit wiring ----
                // Seed the initial baseline. Popover pickers re-seed on toggle→open.
                this._startCommitCycle();

                // Broad user-interaction detector: any pointerdown or input event inside
                // the picker marks the cycle as "user-touched". This covers all gradient
                // controls (add-layer, set-angle, stop drags, textarea edits, etc.) without
                // having to instrument each handler. Library swatches are detected by
                // scope ancestry so a preset pick is correctly flagged as library-sourced.
                this.rootEl.addEventListener('pointerdown', (e) => {
                    const fromLibrary = !!e.target.closest('[x-data*="swatch:"]');
                    this._markUserChange(fromLibrary);
                });
                this.rootEl.addEventListener('input', () => {
                    // 'input' on form controls = user typing / dragging sliders
                    this._markUserChange(false);
                });

                if (this.rootEl.hasAttribute('popover')) {
                    // Popover mode: open/close are the commit boundaries
                    this.rootEl.addEventListener('toggle', (e) => {
                        if (e.newState === 'open')  this._startCommitCycle();
                        if (e.newState === 'closed') {
                            // Write to the triggering swatch's model FIRST — _tryCommitRecent
                            // resets the user-change flag on success, which would otherwise
                            // short-circuit _commitToTrigger.
                            this._commitToTrigger();
                            this._tryCommitRecent();
                        }
                    });
                } else {
                    // Inline mode: commit when focus leaves the picker entirely
                    this.rootEl.addEventListener('focusout', (e) => {
                        const moved = e.relatedTarget;
                        if (!moved || !this.rootEl.contains(moved)) {
                            this._commitToTrigger();
                            this._tryCommitRecent();
                        }
                    });
                }

                // Register in the global registry so $colorpicker(id) bindings resolve
                if (this.rootEl.id) _pickerRegistry[this.rootEl.id] = this.api;

                // Mark complete so the `library` directive handler knows to render into
                // any newly-registered containers (e.g., gradient layer library menus).
                this._mounted = true;
            },

            _injectDefaultUI() {
                this.rootEl.innerHTML = '';
                this.rootEl.appendChild(_defaultFullUiTpl.content.cloneNode(true));

                // Filter / reorder tabs and panels per `allowedPanels` (set on the
                // root state when the directive expression is a panel-list array).
                // No allowedPanels → render all three in their default order.
                const allowed = this.allowedPanels;
                if (allowed && allowed.length) {
                    const wrapper = this.rootEl.firstElementChild;
                    const tabBar = wrapper?.querySelector('[data-cp-tabs]');
                    // Remove tab buttons not in allowed; reorder the rest in `allowed` order
                    if (tabBar) {
                        const tabBtns = Array.from(tabBar.querySelectorAll('[data-cp-tab]'));
                        for (const b of tabBtns) {
                            if (!allowed.includes(b.getAttribute('data-cp-tab'))) b.remove();
                        }
                        for (const name of allowed) {
                            const b = tabBar.querySelector(`[data-cp-tab="${name}"]`);
                            if (b) tabBar.appendChild(b);
                        }
                        // Single panel → no tabs needed, drop the bar entirely
                        if (allowed.length === 1) tabBar.remove();
                    }
                    // Remove panel containers not in allowed; reorder the rest
                    const panels = Array.from(wrapper?.querySelectorAll('[data-cp-panel]') || []);
                    for (const p of panels) {
                        if (!allowed.includes(p.getAttribute('data-cp-panel'))) p.remove();
                    }
                    // Reset the initial `tab` x-data to the first allowed panel and
                    // strip x-show so the lone panel always renders when there's no tab bar.
                    if (wrapper.hasAttribute('x-data')) {
                        wrapper.setAttribute('x-data', `{ tab: '${allowed[0]}' }`);
                    }
                    if (allowed.length === 1) {
                        const lone = wrapper.querySelector(`[data-cp-panel="${allowed[0]}"]`);
                        if (lone) lone.removeAttribute('x-show');
                    }
                }

                // Alpine.initTree fires all x-* directives in the newly injected content,
                // which will register solidTemplate/layerTemplate/solidInstances/layersContainer
                // against THIS state (since ancestor traversal finds this.rootEl).
                if (window.Alpine?.initTree) {
                    Alpine.initTree(this.rootEl);
                }
                // Stash the auto-injected tab scope wrapper so _syncPickerModeFromTab can read it
                this._autoTabScope = this.rootEl.firstElementChild;
            },

            _syncPickerModeFromTab() {
                const rootTab = this.rootEl._x_dataStack?.[0]?.tab;
                const autoTab = this._autoTabScope?._x_dataStack?.[0]?.tab;
                const tab = rootTab || autoTab;
                if (!tab) return;
                // Only Solid/Gradient tabs drive the edit mode — Library (or any other
                // tab) preserves the current mode. Otherwise switching to Library while
                // editing a gradient would silently demote the picker to solid, breaking
                // the "active" indicator on gradient Recent swatches.
                let newMode = null;
                if (tab === 'gradient') newMode = 'gradient';
                else if (tab === 'solid') newMode = 'solid';
                if (!newMode || newMode === this.pickerMode) return;
                this.pickerMode = newMode;
                if (this.isGradient) {
                    this.renderLayers();
                    if (!this.openStop) this._activateControls(null);
                } else {
                    this.openStop = null;
                    this._activateControls(this.solidTabRefs);
                }
                this.syncToInput();
            },
        };

        // ---- Public API exposed via $colorpicker magic ----

        // Reading `state.snapshot.version` inside each getter registers a reactive
        // dependency. When syncToInput bumps the version, any Alpine effect that
        // read these getters re-runs — and only then do we compute the value.
        // Zero computation if nothing is bound.
        const track = () => state.snapshot.version;
        state.api = {
            // Reactive reads — lazily computed on demand
            get hex()        { track(); return state.toHex(); },
            get formatted()  { track(); return state.toActiveColorString(); },
            get css()        { track(); return state.toFormattedString(); },
            get h()          { track(); return state.h; },
            get s()          { track(); return state.s; },
            get v()          { track(); return state.v; },
            get a()          { track(); return state.a; },
            get format()     { track(); return state.format; },
            get pickerMode() { track(); return state.pickerMode; },

            // Default string coercion → current CSS value. Lets the developer write
            //   :style="`background: ${$colorpicker('id')}`"
            //   x-text="$colorpicker('id')"
            // and get the color string directly without picking a specific property.
            [Symbol.toPrimitive]() { track(); return state.toFormattedString(); },
            toString()             { track(); return state.toFormattedString(); },
            valueOf()              { track(); return state.toFormattedString(); },

            // Non-reactive references (direct state)
            get layers() { return state.layers; },
            get activeLayer() { return state.activeLayer(); },
            get activeStop() { return state.activeStop(); },
            get activeLayerIndex() { return state.activeLayerIndex; },
            get activeStopIndex() { return state.activeStopIndex; },
            get openStop() { return state.openStop; },

            // Actions (mirror `.action` modifiers)
            addLayer: () => state.addLayer(),
            addLayerAbove: (i) => state.addLayerAt(i ?? state.activeLayerIndex, 'above'),
            addLayerBelow: (i) => state.addLayerAt(i ?? state.activeLayerIndex, 'below'),
            moveLayerUp: (i) => state.moveLayer(i ?? state.activeLayerIndex, -1),
            moveLayerDown: (i) => state.moveLayer(i ?? state.activeLayerIndex, +1),
            duplicateLayer: (i) => state.duplicateLayer(i ?? state.activeLayerIndex),
            removeLayer: (i) => state.removeLayer(i ?? state.activeLayerIndex),
            flipLayer: (i) => state.flipLayer(i ?? state.activeLayerIndex),
            rotateLayer: (i) => state.rotateLayer(i ?? state.activeLayerIndex),
            duplicateStop: (li, si) => state.duplicateStop(li ?? state.activeLayerIndex, si ?? state.activeStopIndex),
            deleteStop: (li, si) => state.deleteStop(li ?? state.activeLayerIndex, si ?? state.activeStopIndex),
            addStop: (li, pos) => state.addStop(li ?? state.activeLayerIndex, pos),
            setGradientType: (i, type) => state.setGradientType(i ?? state.activeLayerIndex, type),
            applyColor: (str) => state.applyColor(str),
            grabColor: () => state.grabColor(),

            // Setters (mirror `.set-*` modifiers)
            setHue: (v) => state.setHue(v),
            setAlpha: (v) => state.setAlpha(v),
            setAlphaValue: (percent) => state.setAlphaValue(percent),
            setColorSpace: (fmt) => state.setColorSpace(fmt),
            setColorValue: (str) => state.setColorValue(str),
            setAngle: (i, deg) => state.setAngle(i ?? state.activeLayerIndex, deg),
            setGradientValue: (str) => state.setGradientValue(str),

            // Selection / state helpers
            selectStop: (li, si) => state.selectStop(li, si),
            toggleStop: (li, si) => state.toggleStop(li, si),
            setFromString: (str) => state.setFromString(str),
            toFormattedString: () => state.toFormattedString(),
            toHex: () => state.toHex(),

            // Library helpers (global to the plugin; same for every picker)
            get recent() { return _recentStore.list; },
            clearRecent: () => clearRecent(),
            removeRecent: (v) => removeRecent(v),
            pushRecent: (v) => pushRecent(v),
            get presets() { return { tailwind: buildTailwindPreset(), ios: buildIosPreset() }; },
        };

        return state;
    }

    // ---- Helpers for finding in-clone elements ----

    function findInClone(root, modifier) {
        // Match any `x-colorpicker.<modifier>` (possibly with additional modifiers or a value)
        const attrName = 'x-colorpicker.' + modifier;
        if (root.hasAttribute && root.hasAttribute(attrName)) return root;
        return root.querySelector(`[${cssEscapeAttr(attrName)}]`);
    }

    function cssEscapeAttr(name) {
        return name.replace(/\./g, '\\.');
    }

    // Rewrite x-dropdown* trigger attributes and the matching <menu id="..."> inside
    // a cloned subtree so multiple clones don't share the same popover ID.
    function uniquifyDropdownIdsIn(root, suffix) {
        const attrs = ['x-dropdown', 'x-dropdown.context', 'x-dropdown.hover'];
        for (const attr of attrs) {
            const selector = '[' + attr.replace(/\./g, '\\.') + ']';
            const triggers = root.querySelectorAll(selector);
            for (const trigger of triggers) {
                const original = trigger.getAttribute(attr);
                if (!original || /[`${}]/.test(original)) continue; // skip Alpine template literals
                // Only rewrite if we can find the target menu INSIDE this clone
                let menu = null;
                try { menu = root.querySelector('#' + CSS.escape(original)); } catch {}
                if (!menu) continue;
                const newId = original + '--' + suffix;
                trigger.setAttribute(attr, newId);
                menu.id = newId;
            }
        }
    }

    // Coalesce rapid-fire calls (pointermove, input) into at most one per animation frame.
    // The latest args win. Essential for keeping the main thread responsive on busy devices.
    function rafThrottle(fn) {
        let scheduled = false;
        let lastArgs;
        let lastThis;
        return function throttled(...args) {
            lastArgs = args;
            lastThis = this;
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                fn.apply(lastThis, lastArgs);
            });
        };
    }

    // JSON-serialize a value for use in an Alpine x-data attribute via setAttribute.
    // setAttribute does NOT decode HTML entities, so no escaping needed — JSON is
    // already valid JS literal syntax that Alpine can parse directly.
    function _jsonStringifyForAlpine(v) {
        try { return JSON.stringify(v); } catch { return '{}'; }
    }

    // Evaluate an expression in the scope of a given element, outside a directive context
    function evaluateLaterShim(el, expression) {
        if (!window.Alpine?.evaluateLater) {
            return (cb) => { try { cb(new Function('return ' + expression)()); } catch { cb(null); } };
        }
        return Alpine.evaluateLater(el, expression);
    }

    function findAncestorState(el) {
        let n = el;
        while (n) {
            if (n._colorpickerState) return n._colorpickerState;
            n = n.parentElement;
        }
        return null;
    }

    function findLayerContext(el) {
        let n = el;
        while (n) {
            if (n.hasAttribute && n.hasAttribute('data-cp-layer-clone')) {
                return { layerIndex: n._cpLayerIndex, cloneRoot: n };
            }
            n = n.parentElement;
        }
        return null;
    }

    // ---- Directive registration ----

    function registerPlugin() {
        if (!window.Alpine || typeof Alpine.directive !== 'function') return;

        Alpine.directive('colorpicker', (el, { modifiers, expression }, { cleanup, evaluateLater }) => {
            // Root: no modifiers
            if (!modifiers || modifiers.length === 0) {
                // <template x-colorpicker> → registered as the page-wide default
                // override. Every bare swatch (`<button x-colorpicker.swatch>`) that
                // would otherwise auto-create an empty popover instead clones from
                // this template. Only one default per page; first declaration wins.
                if (el.tagName === 'TEMPLATE') {
                    if (expression || el.id) {
                        // Id-keyed templates are no longer supported — declare the
                        // picker inline (`<menu id="X" popover x-colorpicker>`) or
                        // wrap it in a Manifest HTML component for reuse.
                        try { console.warn('[colorpicker] Id-keyed <template x-colorpicker> is no longer supported. Use a live inline element with the same id, or wrap the picker in an HTML component.'); } catch {}
                        return;
                    }
                    registerDefaultColorpickerTemplate(el);
                    return;
                }

                const state = createPickerState(el);
                el._colorpickerState = state;

                // Panel-list expression: `x-colorpicker="['solid', 'gradient']"`.
                // Parsed once here and used by _injectDefaultUI to filter + reorder
                // the default UI's tabs and panels. Anything else is ignored.
                state.allowedPanels = parsePanelsExpression(expression);

                // Find the form-participation input
                state.hiddenInput = el.querySelector('input[type=color], input[type=hidden]');

                // Find trigger button (any button with x-dropdown pointing to this element's ID)
                const id = el.id;
                state.triggerBtn = id ? document.querySelector(`[x-dropdown="${id}"]`) : null;
                if (state.triggerBtn) {
                    state.triggerBtn.addEventListener('click', () => {
                        requestAnimationFrame(() => state.syncUI());
                    });
                }

                // Defer mount so all child directives have had a chance to register.
                // setTimeout (rather than rAF) so we still fire when the tab is
                // backgrounded or rAF is throttled — mount must happen for the
                // picker to work, and it doesn't need to be sync'd with paint.
                setTimeout(() => state.mount(), 0);

                cleanup(() => {
                    if (el.id) delete _pickerRegistry[el.id];
                    delete el._colorpickerState;
                });
                return;
            }

            // Child hook
            const role = modifiers[0];

            // Swatches work as triggers OUTSIDE any picker — handle before the ancestor check.
            // We only assign IDs + generate the popover tag; the dropdown plugin (x-dropdown)
            // owns popover mechanics, anchor positioning, and transitions.
            if (role === 'swatch') {
                if (el._cpSwatchWired) return; // guard against re-firing via initTree
                el._cpSwatchWired = true;

                // ---- Optional x-model binding ----
                // When a swatch carries x-model, the expression is the source of truth for
                // that swatch's color. The plugin:
                //   • reactively shows the model value as the swatch background (via CSS var)
                //   • exposes a read accessor the picker uses on open to load the value
                //   • exposes a write accessor the picker uses on close to persist changes
                // The dev can still apply inline style / class overrides on top.
                const modelExpr = el.getAttribute('x-model');
                if (modelExpr && window.Alpine?.evaluateLater && window.Alpine?.effect) {
                    try {
                        const readFn = Alpine.evaluateLater(el, modelExpr);
                        // Reactive background preview
                        Alpine.effect(() => {
                            readFn(v => {
                                if (typeof v === 'string' && v.length) {
                                    el.style.setProperty('--color-picker-swatch', v);
                                    el.setAttribute('data-cp-model-value', v);
                                }
                            });
                        });
                        el._cpModelGetter = (cb) => readFn(cb);
                        // Writer: evaluate `<modelExpr> = <JSON-stringified value>`. JSON.stringify
                        // ensures the value is safely serialized (color strings + gradient CSS
                        // are all JSON-safe).
                        el._cpModelSetter = (v) => {
                            try { Alpine.evaluate(el, `${modelExpr} = ${JSON.stringify(v)}`); } catch {}
                        };
                    } catch {}
                }

                // ---- Initial color via `value` attribute ----
                // The swatch can carry a `value="#abc123"` attribute (mirrors native
                // <input type="color"> semantics). It seeds the picker on first open
                // and the swatch's CSS var so the border-color derivation paints
                // correctly before any interaction.
                const valueAttr = el.getAttribute('value');
                if (valueAttr && !el.style.getPropertyValue('--color-picker-swatch')) {
                    el.style.setProperty('--color-picker-swatch', valueAttr);
                }

                // ---- Form participation via `name` attribute ----
                // When the swatch has `name=`, the plugin synthesizes a sibling
                // <input type="hidden"> with that name (or adopts a matching one
                // already in the DOM). syncToInput then writes the picker's hex
                // value to it, dispatching input/change events for form code.
                // No `name` → no synthesized input — purely decorative swatch.
                const nameAttr = el.getAttribute('name');
                if (nameAttr) {
                    let hidden = el.parentElement?.querySelector?.(
                        `:scope > input[type=hidden][name="${nameAttr.replace(/"/g, '\\"')}"]`
                    );
                    if (!hidden) {
                        hidden = document.createElement('input');
                        hidden.type = 'hidden';
                        hidden.name = nameAttr;
                        hidden.value = valueAttr || '';
                        el.after(hidden);
                        el._cpSynthesizedHidden = hidden;
                    }
                    el._cpHiddenInput = hidden;
                    // Drop `name` from the swatch itself so the form doesn't pick up
                    // both the (typically empty) button and the hidden input.
                    if (el.tagName === 'BUTTON') el.removeAttribute('name');
                }

                cleanup(() => {
                    if (el._cpSynthesizedHidden && el._cpSynthesizedHidden.isConnected) {
                        el._cpSynthesizedHidden.remove();
                    }
                });

                const wireSwatchTo = (target) => {
                    if (!target) return;

                    // Alias the picker's api under the swatch's id so consumers reading
                    // via `$colorpicker('<swatch-id>')` track the right reactive key
                    // (otherwise the auto-popover registers under `colorpicker-swatch-N`
                    // and the consumer effect's tracked dep on `_pickerRegistry['<swatch-id>']`
                    // would never fire). Run after mount so the api exists.
                    const aliasToSwatchId = () => {
                        if (!el.id) return;
                        const st = target._colorpickerState
                            || target.querySelector?.('[x-colorpicker]')?._colorpickerState;
                        if (st && st.api) _pickerRegistry[el.id] = st.api;
                        else setTimeout(aliasToSwatchId, 0);
                    };
                    aliasToSwatchId();

                    const isDialog = target.tagName === 'DIALOG';

                    // For non-dialog popover targets (menu / div with popover), delegate
                    // open/close + anchor positioning to the dropdowns plugin so the
                    // picker appears anchored to the swatch like a dropdown menu.
                    // <dialog> targets are NOT routed through x-dropdown — dialogs are
                    // modal/centered surfaces, not anchored to a trigger. We open them
                    // imperatively on click via showPopover() or showModal().
                    if (!isDialog
                        && target.hasAttribute('popover')
                        && !el.hasAttribute('popovertarget')
                        && !el.hasAttribute('x-dropdown')) {
                        el.setAttribute('x-dropdown', target.id);
                        if (window.Alpine?.initTree) Alpine.initTree(el);
                    }

                    // Retarget the picker to this swatch on click (load its color + point writes here)
                    el.addEventListener('click', (e) => {
                        // Open dialogs imperatively. Prefer popover semantics when the
                        // dialog has a `popover` attribute (light-dismiss); otherwise
                        // open as a true modal with backdrop and focus trap.
                        if (isDialog) {
                            e.preventDefault();
                            try {
                                if (target.hasAttribute('popover')) {
                                    if (!target.matches(':popover-open')) target.showPopover();
                                } else {
                                    if (!target.open) target.showModal();
                                }
                            } catch {}
                        }

                        const retarget = () => {
                            // Picker state may live on `target` itself (e.g. <menu x-colorpicker>)
                            // or on a descendant when the target is a wrapping container such
                            // as <dialog> hosting <div x-colorpicker> inside.
                            let st = target._colorpickerState;
                            if (!st) {
                                const inner = target.querySelector?.('[x-colorpicker]');
                                if (inner && inner._colorpickerState) st = inner._colorpickerState;
                            }
                            if (!st) { setTimeout(retarget, 0); return; }
                            st.triggerBtn = el;
                            // Route form-participation writes to this swatch's hidden
                            // input (synthesized from `name`, or dev-supplied sibling).
                            // Falls back to whatever the picker container already had
                            // — preserves the existing inline-input flow.
                            if (el._cpHiddenInput) st.hiddenInput = el._cpHiddenInput;
                            // Load the trigger's current value. Priority:
                            //   1. x-model getter (shared-picker flow)
                            //   2. paired hidden input value (form-participation flow)
                            //   3. `value` attribute on the swatch
                            //   4. --color-picker-swatch CSS var (auto / inline-style flow)
                            //   5. fallback '#000000'
                            if (el._cpModelGetter) {
                                el._cpModelGetter(v => { if (typeof v === 'string' && v.length) st.setFromString(v); });
                            } else {
                                const current = (el._cpHiddenInput && el._cpHiddenInput.value)
                                    || el.getAttribute('value')
                                    || el.style.getPropertyValue('--color-picker-swatch')
                                    || getComputedStyle(el).getPropertyValue('--color-picker-swatch').trim()
                                    || '#000000';
                                if (current) st.setFromString(current);
                            }
                            // Defer heavy UI sync so the popover's entry transition runs unimpeded
                            setTimeout(() => st.syncUI(), 0);
                        };
                        retarget();
                    });
                };

                // Panel-list expression on a swatch (`x-colorpicker.swatch="['solid']"`)
                // → not an id, not a template literal — auto-create a popover and pass
                // the panels through so its picker UI is filtered to that subset.
                const panelsExpr = parsePanelsExpression(expression);

                if (!expression) {
                    // Bare swatch → auto-create popover with generated ID
                    wireSwatchTo(createSwatchPopover());
                } else if (panelsExpr) {
                    // Panel list → auto-create popover with the expression preserved
                    wireSwatchTo(createSwatchPopover(undefined, expression));
                } else if (expression.includes('${') || expression.includes('`')) {
                    // Alpine template literal → resolve, then look up or auto-create
                    const evaluator = evaluateLater(expression);
                    evaluator(val => {
                        if (!val) return;
                        const t = resolvePickerById(val) || createSwatchPopover(val);
                        wireSwatchTo(t);
                    });
                } else {
                    // Static ID → resolve via inline / template / auto
                    const t = resolvePickerById(expression) || createSwatchPopover(expression);
                    wireSwatchTo(t);
                }
                return;
            }

            // All other child hooks require an ancestor picker state
            const state = findAncestorState(el);
            if (!state) return;

            switch (role) {
                case 'solid':
                    if (el.tagName === 'TEMPLATE') {
                        state.solidTemplate = el;
                    } else if (!findLayerContext(el)) {
                        // Top-level instance (e.g. Solid tab). Accordion instances
                        // inside a layer clone are handled by renderLayers directly.
                        state.solidInstances.push(el);
                    }
                    return;

                case 'layer-options':
                    if (el.tagName === 'TEMPLATE') state.layerTemplate = el;
                    return;

                case 'gradient':
                    if (el.tagName === 'TEMPLATE') state.gradientTemplate = el;
                    else state.gradientInstances.push(el);
                    return;

                case 'gradient-layers':
                    state.layersContainer = el;
                    return;

                case 'layer-stops-bar':
                    // Handled per-clone in _renderStopBar
                    return;

                // Actions
                case 'add-layer':
                    el.addEventListener('click', () => state.addLayer());
                    return;

                case 'grab-color':
                    el.addEventListener('click', () => state.grabColor());
                    return;

                case 'apply-color': {
                    el.addEventListener('click', () => {
                        // Respect disabled attribute (used when the swatch is a gradient
                        // and the user is editing a gradient stop — CSS doesn't allow
                        // gradients as color stop values).
                        if (el.hasAttribute('disabled')) return;
                        const cs = window.getComputedStyle(el);
                        const raw = el.style.background || el.style.backgroundColor || cs.backgroundColor;
                        if (!raw) return;
                        // Library-swatch clicks are marked so the commit cycle knows not
                        // to record them as "recent" even if the picker closes afterwards.
                        const fromLibrary = !!el.closest('[x-data*="swatch:"]');
                        const fromStopMenu = !!el.closest('menu[id^="stop-context-menu"]');
                        state._markUserChange(fromLibrary);

                        // Top-level library picks (NOT inside a stop-context-menu) replace
                        // the WHOLE field — switch picker mode to match the swatch's value
                        // type so a solid swatch doesn't become a stop in an existing
                        // gradient and a gradient swatch doesn't get parsed as the active
                        // stop's color. Stop-menu picks intentionally write to the right-
                        // clicked stop and stay in gradient mode.
                        // Use _setPickerMode (not _switchToSolidMode) — we don't want to
                        // flip the user off whatever tab they're on (typically Library).
                        const valueIsGradient = raw.includes('gradient(');
                        if (fromLibrary && !fromStopMenu) {
                            state._setPickerMode(valueIsGradient ? 'gradient' : 'solid');
                        }

                        state.applyColor(raw);
                    });
                    return;
                }

                case 'remove-recent': {
                    // Expected placement: a menu item inside a <menu popover> referenced by
                    // x-dropdown.context on a Recent swatch. The dropdowns plugin stashes the
                    // triggering element on `menu._triggerEl`. We read its `data-cp-value`
                    // (the raw stored form) and remove that entry from the Recent cookie.
                    el.addEventListener('click', () => {
                        const menu = el.closest('[popover]');
                        const trigger = menu?._triggerEl || menu?._triggerHost;
                        const value = trigger?.getAttribute?.('data-cp-value');
                        if (value) removeRecent(value);
                    });
                    return;
                }

                case 'duplicate-layer':
                case 'remove-layer':
                case 'flip-layer':
                case 'rotate-layer':
                case 'add-layer-above':
                case 'add-layer-below':
                case 'move-layer-up':
                case 'move-layer-down':
                case 'duplicate-stop':
                case 'delete-stop':
                case 'set-gradient-type': {
                    el.addEventListener('click', () => {
                        // Respect :disabled bindings — Alpine toggles the attribute on the
                        // element; a disabled menu item shouldn't fire its action.
                        if (el.hasAttribute('disabled')) return;
                        const ctx = findLayerContext(el);
                        const li = ctx ? ctx.layerIndex : state.activeLayerIndex;
                        switch (role) {
                            case 'duplicate-layer': state.duplicateLayer(li); break;
                            case 'remove-layer': state.removeLayer(li); break;
                            case 'flip-layer': state.flipLayer(li); break;
                            case 'rotate-layer': state.rotateLayer(li); break;
                            case 'add-layer-above': state.addLayerAt(li, 'above'); break;
                            case 'add-layer-below': state.addLayerAt(li, 'below'); break;
                            case 'move-layer-up':   state.moveLayer(li, -1); break;
                            case 'move-layer-down': state.moveLayer(li, +1); break;
                            case 'duplicate-stop': state.duplicateStop(li, state.activeStopIndex); break;
                            case 'delete-stop': state.deleteStop(li, state.activeStopIndex); break;
                            case 'set-gradient-type': {
                                // Value comes from the expression (Alpine parsed) or the attribute
                                const type = expression || el.getAttribute('x-colorpicker.set-gradient-type');
                                state.setGradientType(li, (type || '').replace(/['"]/g, ''));
                                break;
                            }
                        }
                    });
                    return;
                }

                // Inputs inside layer (angle)
                case 'set-angle': {
                    // Input listener
                    el.addEventListener('input', () => {
                        const ctx = findLayerContext(el);
                        const li = ctx ? ctx.layerIndex : state.activeLayerIndex;
                        state.setAngle(li, parseFloat(el.value) || 0);
                    });
                    // Drag-scrub
                    let scrubbing = false, scrubStartX = 0, scrubStartAngle = 0, scrubLi = 0;
                    el.addEventListener('pointerdown', (e) => {
                        if (document.activeElement === el) return;
                        e.preventDefault();
                        const ctx = findLayerContext(el);
                        scrubLi = ctx ? ctx.layerIndex : state.activeLayerIndex;
                        scrubbing = true;
                        scrubStartX = e.clientX;
                        scrubStartAngle = state.layers[scrubLi]?.angle || 0;
                        el.setPointerCapture(e.pointerId);
                    });
                    const applyScrub = (e) => {
                        const newAngle = scrubStartAngle + (e.clientX - scrubStartX);
                        state.setAngle(scrubLi, Math.round(newAngle));
                        el.value = state.layers[scrubLi]?.angle || 0;
                    };
                    const throttledScrub = rafThrottle(applyScrub);
                    el.addEventListener('pointermove', (e) => {
                        if (!scrubbing) return;
                        throttledScrub(e);
                    });
                    el.addEventListener('pointerup', (e) => {
                        if (scrubbing) {
                            scrubbing = false;
                            if (Math.abs(e.clientX - scrubStartX) < 3) { el.focus(); el.select(); }
                        }
                    });
                    return;
                }

                // Gradient CSS textarea
                case 'set-gradient-value':
                    state.gradientValueInputs.push(el);
                    el.addEventListener('input', () => {
                        state.setGradientValue(el.value);
                    });
                    return;

                // Solid-tab controls (wired via _wireSolidControls when mounted)
                // If the developer places them OUTSIDE a solid-panel instance, wire individually:
                case 'set-canvas':
                case 'set-hue':
                case 'set-alpha':
                case 'set-alpha-value':
                case 'set-color-value': {
                    // These are typically inside a solid-panel template/instance.
                    // (The usual path handles them inside _mountSolidInstance.)
                    return;
                }

                // set-color-space supports two roles:
                //   • With expression (`<li x-colorpicker.set-color-space="hex">`) →
                //     click sets that format. Tracked so we can toggle .active on the
                //     current choice.
                //   • Without expression (`<button x-colorpicker.set-color-space>`) →
                //     reactive label whose text reflects the active format. Useful as
                //     a dropdown trigger that shows the current format.
                //   • <select x-colorpicker.set-color-space> still works through the
                //     legacy _wireSolidControls flow inside a solid-panel instance.
                case 'set-color-space': {
                    if (el.tagName === 'SELECT') return; // legacy flow handles it
                    const raw = (expression || '').replace(/['"`]/g, '').trim().toLowerCase();
                    if (raw) {
                        // Choice element — click selects this format
                        state.formatChoiceEls.push({ el, fmt: raw });
                        el.addEventListener('click', () => {
                            if (el.hasAttribute('disabled')) return;
                            state.setColorSpace(raw);
                        });
                    } else {
                        // Label element — text reflects current format
                        state.formatLabelEls.push(el);
                    }
                    state._refreshFormatLabels();
                    return;
                }

                // ---- Library ----

                case 'library': {
                    if (el.tagName === 'TEMPLATE') {
                        // Dev-defined library layout — cloned into the container at render time.
                        // Nested <template x-colorpicker.library-group/palette/swatch> are resolved
                        // in-place during rendering (x-for style).
                        state.libraryTemplate = el;
                    } else {
                        // Container where the library renders. Multiple containers are supported
                        // (e.g., the primary tab AND inline menus like stop-context-menu); each
                        // receives an independent clone of the library template. The expression
                        // from the FIRST container wins as the data source; others reuse it.
                        if (!state.libraryContainers.includes(el)) {
                            state.libraryContainers.push(el);
                            // If the picker is already mounted, render into ONLY this new
                            // container so other containers' in-flight directive inits
                            // (x-dropdown.context menu lookups, tooltips, etc.) aren't
                            // torn down mid-init.
                            if (state._mounted) state._renderIntoContainer(el);
                        }
                        if (expression && !state.libraryRootValue) state.libraryRootValue = expression;
                    }
                    return;
                }

                case 'library-group':
                case 'library-palette':
                case 'library-swatch':
                case 'library-recent-swatch': {
                    // Nested templates — no registration. Resolved via querySelector at render time
                    // (so their position in the HTML determines where clones land).
                    // `library-recent-swatch` is an optional alternate template used only for
                    // swatches inside the Recent group (typically wires up x-dropdown.context).
                    return;
                }

            }
        });

        // $colorpicker — accessor that is both callable (`$colorpicker('id')`) and property-readable
        // (`$colorpicker.hex` — uses nearest ancestor picker).
        Alpine.magic('colorpicker', (el) => {
            const localState = findAncestorState(el);
            const localApi = localState?.api || null;

            // Function form: `$colorpicker('picker-id')` → that picker's API.
            // Reads from the reactive registry so bindings resolve even when the
            // picker is declared later in the DOM than its consumer.
            const byId = (id) => {
                if (!id) return localApi;
                // Reactive read: tracks the key even if not yet registered
                const api = _pickerRegistry[id];
                if (api) return api;
                // Allow lookup by swatch button ID (resolve through its popovertarget)
                const el2 = document.getElementById(id);
                if (el2 && el2.hasAttribute('popovertarget')) {
                    const popoverId = el2.getAttribute('popovertarget');
                    const api2 = _pickerRegistry[popoverId];
                    if (api2) return api2;
                }
                return _nullApi;
            };

            return new Proxy(byId, {
                get(fn, prop) {
                    // Coerce `${$colorpicker}` (no call) to the local picker's CSS string
                    if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
                        return () => (localApi ? localApi.css : '');
                    }
                    // Global helpers (picker-agnostic) — useful for library composition.
                    // Each is BOTH callable AND spreadable:
                    //   {...$colorpicker.tailwind}         → default English preset
                    //   $colorpicker.tailwind(labels)      → localized preset (same values, translated names)
                    //   {...$colorpicker.tailwind(labels)} → spread the localized result
                    if (prop === 'presets')  return _makeCallablePreset(buildDefaultLibrary);
                    if (prop === 'tailwind') return _makeCallablePreset(buildTailwindPreset);
                    if (prop === 'ios')      return _makeCallablePreset(buildIosPreset);
                    if (prop === 'recent')   return _recentStore.list.slice(0, _recentMax);
                    if (localApi && prop in localApi) return localApi[prop];
                    return fn[prop];
                },
                has(fn, prop) {
                    if (prop === 'presets' || prop === 'tailwind' || prop === 'ios' || prop === 'recent') return true;
                    return (localApi && prop in localApi) || prop in fn;
                }
            });
        });
    }

    // ---- Picker resolution: inline / default-template / auto-generated ----
    //
    // Two ways a dev can declare a picker:
    //   1. Live inline element:    <menu id="brand-picker" popover x-colorpicker>…</menu>
    //                              <dialog id="brand-picker" x-colorpicker>…</dialog>
    //                              <div id="brand-picker" x-colorpicker>…</div>
    //   2. Auto-created (bare):    <button x-colorpicker.swatch> generates its own popover.
    //                              By default, the popover is filled with the plugin's
    //                              hardcoded fallback UI. Devs can override it page-wide
    //                              by adding a single `<template x-colorpicker>` (no id)
    //                              anywhere in the markup — the auto-creator clones from
    //                              that instead.
    //
    // For "componentize and reuse" use cases that previously needed an id-keyed template,
    // wrap the picker in a Manifest HTML component (`<x-my-picker>`) and drop it wherever
    // it's needed. This keeps the plugin's resolution model deliberately small.

    let _defaultColorpickerTemplate = null; // <template x-colorpicker> (no id)

    function registerDefaultColorpickerTemplate(tpl) {
        // First wins. Subsequent declarations are ignored — explicit, no surprises.
        if (!tpl || _defaultColorpickerTemplate) return;
        _defaultColorpickerTemplate = tpl;
    }

    // Resolve a swatch's target by id. Inline elements only — templates are never
    // looked up by id anymore (use a `<menu id="X" x-colorpicker>` or wrap in an
    // HTML component for that pattern).
    function resolvePickerById(id) {
        if (!id) return null;
        const live = document.getElementById(id);
        if (live && live.tagName !== 'TEMPLATE') return live;
        return null;
    }

    // ---- Auto-created fallback popover per swatch ----

    let _swatchPopoverCounter = 0;
    function nextAutoSwatchId() {
        _swatchPopoverCounter++;
        while (document.getElementById('colorpicker-swatch-' + _swatchPopoverCounter)) _swatchPopoverCounter++;
        return 'colorpicker-swatch-' + _swatchPopoverCounter;
    }

    function createSwatchPopover(customId, panelsExpr) {
        const id = customId || nextAutoSwatchId();

        // If a default `<template x-colorpicker>` is registered, clone its root
        // and use that as the swatch's popover. Preserves the dev's chosen
        // wrapper (menu / dialog / div) and any attributes they put on it.
        // The dev's content inside the template is rendered verbatim (mount's
        // noDeclared check sees real children and skips _injectDefaultUI).
        // If the template exists in the DOM but its directive hasn't fired yet
        // (source-order race), scan for it now so swatches earlier in the tree
        // still pick it up.
        if (!_defaultColorpickerTemplate) {
            const candidates = document.querySelectorAll('template[x-colorpicker]');
            for (const t of candidates) {
                if (!t.id && !t.getAttribute('x-colorpicker')) {
                    registerDefaultColorpickerTemplate(t);
                    break;
                }
            }
        }
        let root = null;
        if (_defaultColorpickerTemplate) {
            const frag = _defaultColorpickerTemplate.content.cloneNode(true);
            root = frag.firstElementChild;
        }
        if (root) {
            if (!root.hasAttribute('x-colorpicker')) root.setAttribute('x-colorpicker', panelsExpr || '');
            else if (panelsExpr) root.setAttribute('x-colorpicker', panelsExpr);
            if (root.tagName !== 'DIALOG' && !root.hasAttribute('popover')) root.setAttribute('popover', '');
            root.id = id;
            document.body.appendChild(root);
            if (window.Alpine?.initTree) Alpine.initTree(root);
            return root;
        }

        // No default template → empty <menu> populated by _injectDefaultUI on mount.
        const menu = document.createElement('menu');
        menu.setAttribute('popover', '');
        // Pass the panel-list expression through to the root x-colorpicker directive
        // so the auto-created popover only shows the panels the swatch requested.
        menu.setAttribute('x-colorpicker', panelsExpr || '');
        menu.id = id;
        menu.className = 'colorpicker dropdown-menu';
        document.body.appendChild(menu);
        if (window.Alpine?.initTree) Alpine.initTree(menu);
        return menu;
    }

    // Parse a directive expression as a panel list. Accepts JS array literals like
    // "['solid', 'gradient']" or "[\"library\"]". Returns a normalized array of
    // recognized panel names, or null if the expression isn't a panel list.
    const _validPanels = ['solid', 'gradient', 'library'];
    function parsePanelsExpression(expr) {
        if (!expr || typeof expr !== 'string') return null;
        const trimmed = expr.trim();
        if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
        try {
            // JSON.parse after normalizing single quotes — the expressions we accept
            // are simple string-array literals, so a quote swap is safe.
            const arr = JSON.parse(trimmed.replace(/'/g, '"'));
            if (!Array.isArray(arr)) return null;
            const out = arr
                .map(s => typeof s === 'string' ? s.trim().toLowerCase() : null)
                .filter(s => s && _validPanels.includes(s));
            return out.length ? out : null;
        } catch {
            return null;
        }
    }

    registerPlugin();
}

// Track initialization
let colorpickerPluginInitialized = false;
function ensureColorpickerPluginInitialized() {
    if (colorpickerPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
    colorpickerPluginInitialized = true;
    initializeColorpickerPlugin();
    // Process any x-colorpicker elements already in the DOM
    if (window.Alpine && typeof window.Alpine.initTree === 'function') {
        document.querySelectorAll('[x-colorpicker]').forEach(el => { if (!el.__x) window.Alpine.initTree(el); });
    }
}
window.ensureColorpickerPluginInitialized = ensureColorpickerPluginInitialized;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureColorpickerPluginInitialized);
document.addEventListener('alpine:init', ensureColorpickerPluginInitialized);
if (window.Alpine && typeof window.Alpine.directive === 'function') setTimeout(ensureColorpickerPluginInitialized, 0);
else {
    const check = setInterval(() => { if (window.Alpine && typeof window.Alpine.directive === 'function') { clearInterval(check); ensureColorpickerPluginInitialized(); } }, 10);
    setTimeout(() => clearInterval(check), 5000);
}
