// Piscataqua River, 3D: NECOFS currents on their native FVCOM mesh, particle tracks,
// fused bathymetry and the UNH buoy current profile, over a 4.4 km box centred on the buoy.
//
// mountPane(el, { dataBase, title, controls, onReady }) => { setTime(t), setTheme(light), timeRange(), dispose() }
//   t is epoch seconds UTC. The page owns the clock: the pane never advances time itself and has
//   no time controls. Each source is shown at its latest record at or before t and held until its
//   next record; nothing is interpolated in time. onReady({ t0, t1 }), if given, is called once the
//   data have loaded, with the model's first and last hours (timeRange() returns the same, or null
//   before then), so the page can offer a jump into the window. title: false drops the heading
//   (the page's caption names the view); controls: false drops the Controls panel.
//
// Frame: east and north metres from the buoy (43.06870 N, 70.70790 W); scene x = east,
// scene -z = north, scene y = elevation in metres times the vertical exaggeration.

import { RAMP_LIGHT, RAMP_DARK } from './ramp.js';

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/+esm';
const ORBIT_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js/+esm';
let threeLoad = null;
function loadThree() {
    if (!threeLoad) {
        threeLoad = Promise.all([import(THREE_URL), import(ORBIT_URL)]).then(([T, O]) => ({
            THREE: T,
            OrbitControls: O.OrbitControls,
        }));
    }
    return threeLoad;
}

// ---- constants -------------------------------------------------------------------------------

const SPEED_MIN = 0.02, SPEED_MAX = 3.1; // m/s, the currents ramp's log axis
const BUOY_CELL_TOP = 0.35;              // m, nominal profiler depth (unconfirmed)
const BUOY_CELL_SIZE = 1.0;              // m, nominal cell size (unconfirmed)
const BUOY_GOOD_CELLS = 10;              // cells 11 to 20 look like noise at or below the bed
// Heights are metres above local mean sea level. The survey DEM is in NAVD88; NOAA CO-OPS 8423898
// Fort Point, NH (datums accepted 2016, epoch 1983 to 2001) puts MSL 0.095 m below NAVD88, so the
// DEM was raised by 0.095 m (8419870 Seavey Island gives 0.077 m). FVCOM's h and zeta are relative
// to the model's own mean sea level and are drawn as they are.
const MSL_BELOW_NAVD88 = 0.095;
const BUOY_BED = -10.2 + MSL_BELOW_NAVD88; // m MSL, measured seabed at the buoy (10.2 m below NAVD88)
const ARROW_M_PER_MS = 1000;             // horizontal metres of arrow per m/s
const CURTAIN_AZ = { along: 342, across: 72 }; // degrees true: the PIR0701 flood axis, and across it
// Land is exaggerated less than water: above LAND_KNEE (m MSL, above the window's highest model
// surface, 2.2 m) heights are scaled by LAND_RELIEF before the scene's vertical exaggeration.
const LAND_KNEE = 2.5;
// Curtain: signed current along its line on a diverging scale, symmetric, fixed at +-CURTAIN_MAX m/s
// (the window's 99th percentile of |along| is 0.73 m/s on the channel line, 1.05 m/s across it).
// Blue for negative (against the line bearing), brown for positive, a pale butter at zero.
const CURTAIN_MAX = 0.8;  // just above the 0.73 m/s along-channel 99th percentile; stronger cross-channel flow clamps
const CURTAIN_ALPHA = 0.8;
const DIVERGING_LIGHT = ['#1d4a8a', '#5a8fc0', '#e8d781', '#b08a62', '#6b4a2b'];
const DIVERGING_DARK = ['#4f8fd0', '#8db8dc', '#f3e49b', '#d6b388', '#a87f58'];
// Difference arrows: a rose-to-plum sequential scale by |model minus measured|, linear from 0 to
// DIFF_TOP m/s and clamped above, translucent. The plum end stays warm and reddish, clear of the
// site's violet (wind). Light: lightness falling with the error; dark: rising.
const DIFF_TOP = 0.3;
const DIFF_ALPHA = 0.55;
const DIFF_LIGHT = ['#f2c9d2', '#d98ea0', '#b8566f', '#8a2f52', '#5c1a3d'];
const DIFF_DARK = ['#4a1f34', '#7a2d4f', '#a8476a', '#d2788f', '#f2b8c6'];
function diffColour(ms, light) {
    const ramp = (light ? DIFF_LIGHT : DIFF_DARK).map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    const f = Math.min(1, Math.max(0, ms / DIFF_TOP)) * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, Math.floor(f)), t = f - i;
    return `rgb(${ramp[i].map((x, k) => Math.round(x + (ramp[i + 1][k] - x) * t)).join(',')})`;
}
function divergingLut(stops) {
    // 256 linear-RGB entries from -CURTAIN_MAX (index 0) to +CURTAIN_MAX (255), RGB-interpolated in sRGB.
    const rgb = stops.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    const lut = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        const f = (i / 255) * (rgb.length - 1), j = Math.min(rgb.length - 2, Math.floor(f)), t = f - j;
        for (let c = 0; c < 3; c++) lut[i * 3 + c] = srgbToLinear((rgb[j][c] + (rgb[j + 1][c] - rgb[j][c]) * t) / 255);
    }
    return lut;
}
const LAND_RELIEF = 0.1;
// Tracer speed scales (the particle variants of the teal ramps, kept in a lightness band clear of
// the relief), [m/s, sRGB] at the ramps' knots, interpolated in log speed.
const hexRow = (s, h) => [s, ...[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))];
const TRACER_DARK = [[0.02, '#1f5e63'], [0.1, '#227a7a'], [0.494, '#2c9a94'], [2.418, '#4fc4b8'], [3.1, '#a4f1e6']].map((r) => hexRow(...r));
const TRACER_LIGHT = [[0.02, '#68a8a2'], [0.1, '#3f9a93'], [0.494, '#15807a'], [2.418, '#09635f'], [3.1, '#023f44']].map((r) => hexRow(...r));

const THEMES = {
    dark: {
        bg: '#0d1418', ink: '#ffffff', inkSoft: 'rgba(255,255,255,0.85)', dim: '#9aa8b3',
        faint: '#6f7c86', rule: 'rgba(255,255,255,0.18)', accent: '#decf03', panel: 'rgba(26,31,36,0.92)',
        buttonInk: '#111111', edge: [1, 1, 1], edgeAlpha: 0.13, arrow: '#decf03', label: '#ffffff',
        sea: [[11, 18, 22], [22, 32, 38], [36, 46, 52]],     // deep, mid, shallow (L* about 6 to 18)
        land: [[46, 43, 38], [70, 66, 58]],                  // low, high
        nbed: [58, 50, 40],
        ramp: RAMP_DARK, tracer: TRACER_DARK, diverging: DIVERGING_DARK,
    },
    light: {
        bg: '#efebe2', ink: '#1c2a48', inkSoft: '#24345a', dim: '#56657f', faint: '#7b8496',
        rule: 'rgba(28,42,72,0.16)', accent: '#15338a', panel: 'rgba(250,247,240,0.95)',
        buttonInk: '#fdfbf6', edge: [0.11, 0.16, 0.28], edgeAlpha: 0.2, arrow: '#b89300', label: '#1c2a48',
        sea: [[196, 206, 212], [214, 221, 224], [230, 233, 230]],
        land: [[236, 226, 198], [222, 207, 168]],
        nbed: [214, 196, 160],
        ramp: RAMP_LIGHT, tracer: TRACER_LIGHT, diverging: DIVERGING_LIGHT,
    },
};

// Measured currents (the UNH buoy) are gold; model output (NECOFS cells, bed, tracers) stays on the
// teal currents ramps. One fixed linear scale, 0 to 0.5 m/s, as on longhorizon.blue.
export const MEASURED_TOP = 0.5; // m/s
const MEASURED_LIGHT = ['#f7f0d8', '#ead28a', '#d0a930', '#a37b00', '#5f4600'];
const MEASURED_DARK = ['#2b2410', '#5e4b10', '#9c7c0c', '#d6b30a', '#fde047'];
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** The colour of a measured speed (m/s) on the light or dark theme, as a CSS rgb() string. */
export function measuredColour(ms, light) {
    const ramp = light ? MEASURED_LIGHT : MEASURED_DARK;
    const f = Math.min(1, Math.max(0, ms / MEASURED_TOP)) * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, Math.floor(f));
    const a = hexRgb(ramp[i]), b = hexRgb(ramp[i + 1]), t = f - i;
    return `rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * t)).join(',')})`;
}

// ---- small helpers ----------------------------------------------------------------------------

function srgbToLinear(x) { return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
function speedLut(ramp) {
    // 256 entries on log(speed) from SPEED_MIN to SPEED_MAX, interpolated in log speed between knots.
    const lut = new Float32Array(256 * 3);
    const lk = ramp.map((r) => Math.log(r[0]));
    const a = Math.log(SPEED_MIN), b = Math.log(SPEED_MAX);
    for (let i = 0; i < 256; i++) {
        const ls = a + (b - a) * (i / 255);
        let j = 0;
        while (j < ramp.length - 2 && lk[j + 1] < ls) j++;
        const f = Math.min(1, Math.max(0, (ls - lk[j]) / (lk[j + 1] - lk[j])));
        // Stored linear: three.js treats vertex colours as linear and encodes the output to sRGB.
        for (let c = 0; c < 3; c++) lut[i * 3 + c] = srgbToLinear(((1 - f) * ramp[j][c + 1] + f * ramp[j + 1][c + 1]) / 255);
    }
    return lut;
}
function lutIndex(speed) {
    const s = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
    return Math.round((Math.log(s) - Math.log(SPEED_MIN)) / (Math.log(SPEED_MAX) - Math.log(SPEED_MIN)) * 255);
}
function latestAtOrBefore(times, t) {
    // Index of the last element of the sorted array `times` that is <= t, or -1.
    let lo = 0, hi = times.length - 1, k = -1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (times[m] <= t) { k = m; lo = m + 1; } else hi = m - 1;
    }
    return k;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtUtc(t) {
    const d = new Date(t * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
function rgbCss(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }
function joinUrl(base, name) { return base.endsWith('/') ? base + name : base + '/' + name; }
async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
}
async function getBin(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.arrayBuffer();
}

// ---- styles (scoped to .pqp) -----------------------------------------------------------------

const CSS = `
.pqp { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--pqp-bg);
  color: var(--pqp-ink); font-family: "Josefin Sans", "Futura", "Century Gothic", sans-serif; font-size: 13px;
  line-height: 1.35; -webkit-tap-highlight-color: transparent; }
.pqp canvas { display: block; width: 100%; height: 100%; touch-action: none; outline: none; }
.pqp-hud { position: absolute; pointer-events: none; }
.pqp-hud > * { pointer-events: auto; }
.pqp-top { left: 10px; top: 8px; right: 10px; display: flex; flex-direction: column; gap: 2px; pointer-events: none; }
.pqp-title { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; color: var(--pqp-ink); pointer-events: none; }
.pqp-status { font-family: "Martian Mono", ui-monospace, Menlo, monospace; font-size: 11px; color: var(--pqp-dim);
  pointer-events: none; }
.pqp-status b { color: var(--pqp-ink-soft); font-weight: 500; }
.pqp-top { right: 56px; } /* clear of the panel's icon button */
.pqp-panelwrap { right: 10px; top: 8px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  max-height: calc(100% - 16px); }
.pqp-iconbtn { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; cursor: pointer; color: var(--pqp-ink);
  background: var(--pqp-panel); border: 1px solid var(--pqp-rule); border-radius: 3px; }
.pqp-iconbtn:hover { border-color: var(--pqp-accent); }
.pqp-iconbtn[aria-expanded="true"] { background: var(--pqp-accent); color: var(--pqp-button-ink); border-color: var(--pqp-accent); }
.pqp-btn { min-height: 28px; padding: 0 10px; font: 600 9.5px/1 "Josefin Sans", "Futura", "Century Gothic", sans-serif;
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--pqp-ink-soft); background: var(--pqp-panel);
  border: 1px solid var(--pqp-rule); border-radius: 3px; cursor: pointer; white-space: nowrap; }
.pqp-btn:hover { color: var(--pqp-ink); border-color: var(--pqp-accent); }
.pqp-btn[aria-pressed="true"], .pqp-btn[aria-expanded="true"] { background: var(--pqp-accent); color: var(--pqp-button-ink); border-color: var(--pqp-accent); }
.pqp-panel { background: var(--pqp-panel); border: 1px solid var(--pqp-rule); border-radius: 3px; padding: 6px 10px 10px;
  width: 212px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.pqp-panel[hidden] { display: none; }
.pqp-panel h4 { margin: 6px 0 0; padding-top: 6px; border-top: 1px solid var(--pqp-rule); font-size: 8.5px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase; color: var(--pqp-faint); }
.pqp-panel h4:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.pqp-row { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
.pqp-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.pqp-panel select, .pqp-panel input[type=range] { font: inherit; font-size: 11.5px; color: var(--pqp-ink);
  background: transparent; border: 1px solid var(--pqp-rule); border-radius: 3px; max-width: 118px; }
.pqp-panel select option { color: #111; }
.pqp-panel input[type=range] { width: 100px; accent-color: var(--pqp-accent); border: none; }
.pqp-panel input[type=checkbox] { accent-color: var(--pqp-accent); }
.pqp-panel .pqp-btn { min-height: 26px; padding: 0 8px; }
.pqp-acts { justify-content: flex-start; margin-top: 2px; padding-top: 8px; border-top: 1px solid var(--pqp-rule); }
.pqp-note { font-size: 11px; color: var(--pqp-dim); }
.pqp-legend { left: 10px; bottom: 26px; background: var(--pqp-panel); border: 1px solid var(--pqp-rule); border-radius: 4px;
  padding: 7px 9px; max-width: 300px; display: flex; flex-direction: column; gap: 5px; font-size: 11px; }
.pqp-legend .pqp-k { color: var(--pqp-dim); }
.pqp-legbody { display: flex; flex-direction: column; gap: 5px; max-height: 46vh; overflow-y: auto; }
.pqp-bar { height: 9px; border-radius: 2px; border: 1px solid var(--pqp-rule); }
.pqp-ticks { display: flex; justify-content: space-between; color: var(--pqp-dim); font-size: 10px;
  font-family: "Martian Mono", ui-monospace, Menlo, monospace; }
.pqp-credits { right: 10px; bottom: 6px; left: 10px; text-align: right; font-size: 10px; color: var(--pqp-faint);
  pointer-events: none; }
.pqp-msg { left: 50%; top: 50%; transform: translate(-50%, -50%); background: var(--pqp-panel); border: 1px solid var(--pqp-rule);
  border-radius: 4px; padding: 10px 14px; text-align: center; max-width: 80%; }
.pqp-msg[hidden] { display: none; }
.pqp-out { color: var(--pqp-ink-soft); }
/* The legend starts closed to its button, at every width; the (i) beside it opens the notes. */
.pqp-legbtns { display: flex; gap: 6px; align-items: center; }
.pqp-legbtns .pqp-iconbtn { width: 28px; height: 28px; }
.pqp-about { inset: 10px; z-index: 3; overflow-y: auto; padding: 10px 14px 12px; background: var(--pqp-bg); border: 1px solid var(--pqp-rule);
  border-radius: 3px; font-size: 12px; line-height: 1.45; color: var(--pqp-ink-soft); }
.pqp-about[hidden] { display: none; }
.pqp-about-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px; color: var(--pqp-ink); font-size: 13px; }
.pqp-about h5 { margin: 10px 0 2px; font-size: 8.5px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: var(--pqp-faint); }
.pqp-about p { margin: 0; max-width: 72ch; }
.pqp-legend[data-collapsed="true"] { padding: 0; background: none; border: 0; }
.pqp-legend[data-collapsed="true"] .pqp-legbody { display: none; }
.pqp-exag { font-size: 11px; color: var(--pqp-dim); pointer-events: none; }
.pqp-exag b { color: var(--pqp-ink-soft); font-weight: 600; }
.pqp-more { font-size: 11px; color: var(--pqp-dim); }
.pqp-more summary { cursor: pointer; color: var(--pqp-ink-soft); list-style-position: inside; }
.pqp-more p { margin: 4px 0 2px; }
.pqp-table { border-collapse: collapse; width: 100%; margin-top: 3px; font-family: "Martian Mono", ui-monospace, Menlo, monospace; font-size: 10px; }
.pqp-table th, .pqp-table td { text-align: right; padding: 1px 4px; border-bottom: 1px solid var(--pqp-rule); }
.pqp-table th { font-weight: 500; color: var(--pqp-ink-soft); }
.pqp-row.pqp-checks { justify-content: flex-start; gap: 8px; flex-wrap: wrap; }
@media (max-width: 560px) {
  .pqp-checks { flex-wrap: wrap; justify-content: flex-start; gap: 10px; }
  .pqp-legbody { max-height: none; }
  .pqp-title { font-size: 13px; }
  .pqp-status { font-size: 10px; }
  .pqp-panelwrap { right: 8px; max-height: calc(100% - 60px); }
  .pqp-panel { width: min(212px, calc(100vw - 40px)); }
  .pqp-btn { min-height: 36px; }
  .pqp-legend { left: 8px; bottom: 46px; max-width: calc(100% - 110px); }
}
`;

function themeVars(th) {
    // On longhorizon.blue the panel's text and controls take the site's own colours (read after the page has set its
    // theme); the pane's values stand in elsewhere. The scene's background stays the pane's.
    const css = getComputedStyle(document.documentElement);
    const site = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
        '--pqp-bg': th.bg, '--pqp-ink': site('--ink', th.ink), '--pqp-ink-soft': site('--ink-soft', th.inkSoft),
        '--pqp-dim': site('--dim', th.dim), '--pqp-faint': site('--faint', th.faint), '--pqp-rule': site('--rule', th.rule),
        '--pqp-accent': site('--accent', th.accent), '--pqp-panel': th.panel, '--pqp-button-ink': site('--bg', th.buttonInk),
    };
}

// ---- the pane --------------------------------------------------------------------------------

export function mountPane(el, opts = {}) {
    const dataBase = opts.dataBase || './data/';
    const onReady = typeof opts.onReady === 'function' ? opts.onReady : null;
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : null; // a control or the camera moved
    const showTitle = opts.title !== false;
    const showControls = opts.controls !== false;

    const state = {
        t: null, light: false, exag: 10, disposed: false, ready: false,
        cells: 'surface', layer: 1, cellOpacity: 0.3, curtain: false, curtainAz: 'along', edges: true,
        bed: 'dem', tracers: true, trailH: 3, buoy: true, buoyDeep: false, showMeas: true, showModel: true, showDiff: false, opacityTouched: false,
        profiles: 'both', curtainMode: 'off', // the panel's two combined choices (onControl maps them onto the flags above)
    };

    // DOM
    if (!document.getElementById('pqp-style')) {
        const st = document.createElement('style');
        st.id = 'pqp-style';
        st.textContent = CSS;
        document.head.appendChild(st);
    }
    const root = document.createElement('div');
    root.className = showTitle ? 'pqp' : 'pqp pqp-notitle';
    root.innerHTML = `
      <div class="pqp-hud pqp-top">
        ${showTitle ? '<div class="pqp-title">Piscataqua River, Portsmouth Harbor, 3D</div>' : ''}
        <div class="pqp-status" aria-live="polite">Loading</div>
        <div class="pqp-exag">Vertical exaggeration <b data-v="exagTop">10</b>x (land above 2.5 m MSL <b data-v="landTop">1</b>x)</div>
      </div>
      <div class="pqp-hud pqp-panelwrap"${showControls ? '' : ' hidden'}>
        <button class="pqp-iconbtn pqp-toggle" aria-expanded="false" aria-label="Layers and view" title="Layers and view">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 2 1.5 5.5 8 9l6.5-3.5L8 2Z M1.5 8.5 8 12l6.5-3.5 M1.5 11 8 14.5l6.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>
        <div class="pqp-panel" hidden>
          <div class="pqp-row"><span>Buoy profile</span><select data-k="profiles">
            <option value="both">Both</option><option value="meas">Measured</option>
            <option value="model">Model</option><option value="diff">Difference</option><option value="none">None</option></select></div>
          <div class="pqp-row"><span>Model cells</span><select data-k="cells">
            <option value="surface">Surface</option><option value="all">All layers</option><option value="none">None</option></select></div>
          <div class="pqp-row"><span>Curtain</span><select data-k="curtainMode">
            <option value="off">Off</option><option value="along">Along channel</option><option value="across">Across channel</option></select></div>
          <div class="pqp-row"><span>Seabed</span><select data-k="bed">
            <option value="dem">Survey</option><option value="necofs">Model</option>
            <option value="both">Both</option><option value="none">None</option></select></div>
          <div class="pqp-row pqp-checks"><label><input type="checkbox" data-k="tracers" checked>Tracers</label>
            <label><input type="checkbox" data-k="edges" checked>Mesh</label></div>
          <div class="pqp-row"><span>Vertical <b data-v="exag">10</b>x</span>
            <input type="range" data-k="exag" min="1" max="30" step="1" value="10" aria-label="Vertical exaggeration"></div>
          <div class="pqp-row pqp-acts"><button class="pqp-btn" data-act="focus">Focus buoy</button>
            <button class="pqp-btn" data-act="reset">Reset view</button></div>
        </div>
      </div>
      <div class="pqp-hud pqp-legend" data-collapsed="true">
        <div class="pqp-legbtns"><button class="pqp-btn pqp-legtoggle" aria-expanded="false">Legend</button>
          <button class="pqp-iconbtn pqp-info" data-act="about" aria-expanded="false" aria-label="About the 3D view" title="About the 3D view">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.8" r="0.9" fill="currentColor"/></svg></button></div>
        <div class="pqp-legbody">
          <div><span class="pqp-k"><b>Model (NECOFS)</b> speed, <span data-u>m/s</span> (log)</span>
            <div class="pqp-bar" data-bar="speed"></div>
            <div class="pqp-ticks" data-ticks="speed"><span>0.02</span><span>0.1</span><span>0.5</span><span>1</span><span>3.1</span></div></div>
          <div data-leg="buoy"><span class="pqp-k"><b>Measured (UNH buoy)</b> speed, <span data-u>m/s</span></span>
            <div class="pqp-bar" data-bar="measured"></div>
            <div class="pqp-ticks" data-ticks="measured"><span>0</span><span>0.1</span><span>0.2</span><span>0.3</span><span>0.4</span><span>0.5+</span></div></div>
          <div data-leg="curtain" style="display:none"><span class="pqp-k"><b>Curtain</b>: <span data-v="curtainTxt"></span></span>
            <div class="pqp-bar" data-bar="curtain"></div>
            <div class="pqp-ticks" data-ticks="curtain"><span>-0.8</span><span>0</span><span>+0.8</span></div></div>
          <div data-leg="buoy"><span class="pqp-k">Profile arrows</span> <svg width="56" height="10" viewBox="0 0 64 10" style="vertical-align:middle">
            <path data-arrow d="M0 4 H50 V1 L64 5 L50 9 V6 H0 Z"/></svg> <span data-v="arrowscale"></span></div>
          <div data-diff style="display:none"><span class="pqp-k"><b>Model minus measured</b>, <span data-u>m/s</span></span>
            <div class="pqp-bar" data-bar="diff"></div>
            <div class="pqp-ticks" data-ticks="diff"><span>0</span><span>0.1</span><span>0.2</span><span>0.3+</span></div>
            <span class="pqp-k">Nearest model layer, buoy record within 5 min of the model hour.</span>
            <details class="pqp-more"><summary>Difference by cell</summary>
              <table class="pqp-table"><thead><tr><th>Cell</th><th>Layer</th><th>|diff| <span data-u>m/s</span></th><th>Angle deg</th></tr></thead><tbody></tbody></table>
              <p>Angle: model direction minus measured, positive clockwise. Directions true. Flagged buoy records are excluded.</p></details></div>
        </div>
      </div>
      <div class="pqp-hud pqp-about" role="dialog" aria-modal="false" aria-label="About the 3D view" hidden>
        <div class="pqp-about-head"><b>About the 3D view</b><button class="pqp-btn" data-act="about-close">Close</button></div>
        <h5>Tracers</h5>
        <p>Particle tracks computed offline with FVCOM's own method (which takes the hourly fields linear in time while
        integrating), shown at their 5-minute records. Coloured by speed over each record on the particle variant of the
        model's teal scale, kept clear of the seabed's lightness; faded along a 3 h trail, newest segment brighter.
        Released every 3 h at 1, 5 and 10 m depth on a 9 by 9 grid across the box; each lives 9 h.</p>
        <h5>Measured profile</h5>
        <p>One arrow per profiler cell, at the buoy. Buoy directions converted from magnetic to true north
        (declination <span data-v="decl">14.2</span> deg W, WMM2025); the logged values are inferred to be magnetic,
        not confirmed by UNH. Cell size unconfirmed (about 1 m cells from a profiler near 0.35 m fits the data).
        Cells 11 to 20 look like noise at or below the seabed (10.2 m below NAVD88) and are not drawn.
        Faded arrows: record flagged suspect (tilt over 20 deg) or failed.</p>
        <h5>Model profile</h5>
        <p>NECOFS u, v at the layer centres of the model element that holds the buoy, every third of its 45 layers
        (1, 4, ... 43), at the current hourly record; directions true. Drawn at the buoy, behind the measured stack
        and fainter. Coloured on the tracers' teal scale.</p>
        <h5>Curtain</h5>
        <p>Vertical slice of the model cells along a line through the buoy, each element-layer one flat colour: the
        velocity component along the line (u sin a + v cos a for the line's bearing a), on a fixed symmetric scale of
        plus or minus 0.8 m/s, clamped beyond (the window's 99th percentile is 0.73 m/s along the channel and 1.05 m/s across it), drawn at 0.8 opacity.</p>
        <h5>Datums</h5>
        <p>Heights are relative to local mean sea level. The survey DEM was raised 0.095 m from NAVD88 (NOAA CO-OPS
        8423898 Fort Point, NH, epoch 1983 to 2001; Seavey Island 8419870 gives 0.077 m). NECOFS bed and surface are
        relative to the model's own mean sea level.</p>
        <h5>Exaggeration</h5>
        <p>Water and seabed at <span data-v="exag2">10</span>x, land above 2.5 m MSL at <span data-v="landx2">1</span>x.
        Box 4.4 km, centred on the buoy.</p>
      </div>
      <div class="pqp-hud pqp-credits">Currents model: NECOFS (FVCOM GOM7), UMass Dartmouth SMAST. Buoy data: UNH. Bathymetry: NOAA, USACE, USGS.</div>
      <div class="pqp-hud pqp-msg" hidden></div>`;
    el.appendChild(root);
    const $ = (s) => root.querySelector(s);
    const statusEl = $('.pqp-status');
    const msgEl = $('.pqp-msg');
    const panel = $('.pqp-panel');
    const toggleBtn = $('.pqp-toggle');
    const legend = $('.pqp-legend');

    const narrow = () => root.clientWidth <= 560;
    function setPanelOpen(open) {
        panel.hidden = !open;
        toggleBtn.setAttribute('aria-expanded', String(open));
    }
    setPanelOpen(false); // the panel and the legend start closed, so the scene has the box
    // On a narrow pane the controls and the legend share the space, so opening one closes the other.
    function setLegendOpen(open) {
        legend.dataset.collapsed = String(!open);
        $('.pqp-legtoggle').setAttribute('aria-expanded', String(open));
    }
    toggleBtn.addEventListener('click', () => {
        const open = panel.hidden;
        setPanelOpen(open);
        if (open && narrow()) setLegendOpen(false);
    });
    $('.pqp-legtoggle').addEventListener('click', () => {
        const open = legend.dataset.collapsed === 'true';
        setLegendOpen(open);
        if (open && narrow()) setPanelOpen(false);
    });

    function applyThemeCss() {
        const th = THEMES[state.light ? 'light' : 'dark'];
        for (const [k, v] of Object.entries(themeVars(th))) root.style.setProperty(k, v);
        const lut = th.ramp;
        const stops = [];
        const a = Math.log(SPEED_MIN), b = Math.log(SPEED_MAX);
        for (const r of lut) stops.push(`${rgbCss(r.slice(1))} ${(((Math.log(r[0]) - a) / (b - a)) * 100).toFixed(1)}%`);
        $('[data-bar="speed"]').style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
        const ms = [];
        for (let i = 0; i <= 20; i++) ms.push(`${measuredColour(MEASURED_TOP * (i / 20), state.light)} ${i * 5}%`);
        $('[data-bar="measured"]').style.background = `linear-gradient(90deg, ${ms.join(', ')})`;
        $('[data-arrow]').setAttribute('fill', measuredColour(0.5, state.light));
        // Tick positions: log axis for the model ramp, square-root axis for the measured one.
        const place = (sel, vals, pos) => {
            const box = $(sel);
            box.style.position = 'relative';
            box.style.height = '12px';
            box.querySelectorAll('span').forEach((s, i) => {
                s.style.position = 'absolute';
                s.style.left = `${(pos(vals[i]) * 100).toFixed(1)}%`;
                s.style.transform = i === 0 ? 'none' : i === vals.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)';
            });
        };
        place('[data-ticks="speed"]', [0.02, 0.1, 0.5, 1, 3.1], (v) => (Math.log(v) - a) / (b - a));
        place('[data-ticks="measured"]', [0, 0.1, 0.2, 0.3, 0.4, 0.5], (v) => v / MEASURED_TOP);
        $('[data-bar="curtain"]').style.background = `linear-gradient(90deg, ${th.diverging.join(', ')})`;
        place('[data-ticks="curtain"]', [-0.8, 0, 0.8], (v) => (v + CURTAIN_MAX) / (2 * CURTAIN_MAX));
        $('[data-bar="diff"]').style.background = `linear-gradient(90deg, ${(state.light ? DIFF_LIGHT : DIFF_DARK).join(', ')})`;
        place('[data-ticks="diff"]', [0, 0.1, 0.2, 0.3], (v) => v / DIFF_TOP);
    }
    applyThemeCss();
    // Speeds in the page's unit (setUnits): the legend's words, its tick labels and the difference table. The scales
    // themselves stay where they are in m/s; only their labels change.
    const UNITS = { ms: { f: 1, label: 'm/s' }, kt: { f: 1.943844, label: 'kt' }, mph: { f: 2.236936, label: 'mph' } };
    let unit = 'ms';
    const unitOf = () => UNITS[unit];
    function applyUnits() {
        const u = unitOf();
        root.querySelectorAll('[data-u]').forEach((s) => { s.textContent = u.label; });
        root.querySelectorAll('[data-ticks] span').forEach((s) => {
            if (!s.dataset.ms) s.dataset.ms = s.textContent; // the m/s label, kept to convert from
            const m = s.dataset.ms.match(/^([+-]?)([\d.]+)(\+?)$/);
            if (!m) return;
            const v = Number(m[2]) * u.f;
            s.textContent = `${m[1]}${v === 0 ? '0' : Number(v.toPrecision(2))}${m[3]}`;
        });
        $('[data-v="arrowscale"]').textContent = `${Number((0.5 * u.f).toPrecision(2))} ${u.label} = ${0.5 * ARROW_M_PER_MS} m on the ground`;
        $('[data-v="curtainTxt"]').textContent = state.curtainAz === 'along'
            ? `current along the line, ${u.label}; blue ebb (toward 162 deg), brown flood (toward 342 deg)`
            : `current along the line, ${u.label}; blue toward 252 deg, brown toward 72 deg`;
    }
    applyUnits();

    // Scene objects, filled in by init().
    let THREE = null, renderer = null, scene = null, camera = null, controls = null, world = null;
    let raf = 0, needsRender = true, ro = null;
    let mesh = null, nec = null, dem = null, trk = null, buoy = null, profile = null;
    const objs = {};
    const disposables = [];
    const track = (o) => { disposables.push(o); return o; };

    function showMsg(text) {
        msgEl.hidden = !text;
        msgEl.textContent = text || '';
    }
    showMsg('Loading 3D view');

    // ---- controls wiring ----
    root.querySelectorAll('[data-k]').forEach((inp) => {
        const k = inp.dataset.k;
        const ev = inp.type === 'range' ? 'input' : 'change';
        inp.addEventListener(ev, () => {
            if (inp.type === 'checkbox') state[k] = inp.checked;
            else if (inp.type === 'range') state[k] = Number(inp.value);
            else state[k] = isNaN(Number(inp.value)) ? inp.value : Number(inp.value);
            onControl(k);
            if (onChange) onChange();
        });
    });
    // The panel's choices and the camera, for a shared link (getState / setState).
    const PANEL_KEYS = ['profiles', 'cells', 'curtainMode', 'bed', 'tracers', 'edges', 'exag'];
    let pendingCam = null; // a camera asked for before the scene exists
    let camMoved = false; // the camera is in a link only once moved from the default (orbit, Focus buoy, a link)
    function applyCam(c) {
        camMoved = true;
        camera.position.set(c[0], c[1], c[2]);
        controls.target.set(c[3], c[4], c[5]);
        controls.update();
        needsRender = true;
    }
    root.querySelector('[data-act="reset"]').addEventListener('click', () => { resetView(); camMoved = false; if (onChange) onChange(); });
    root.querySelector('[data-act="focus"]').addEventListener('click', () => { if (state.ready) { focusBuoy(); camMoved = true; if (onChange) onChange(); } });
    // The notes on each layer, in one panel over the scene (the (i) beside Legend opens it; Close or Escape shuts it).
    const about = $('.pqp-about'), aboutBtn = $('[data-act="about"]');
    const setAbout = (open) => { about.hidden = !open; aboutBtn.setAttribute('aria-expanded', String(open)); };
    aboutBtn.addEventListener('click', () => setAbout(about.hidden));
    $('[data-act="about-close"]').addEventListener('click', () => { setAbout(false); aboutBtn.focus(); });
    about.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setAbout(false); aboutBtn.focus(); } });

    function onControl(k) {
        // Combined choices: one menu each for the buoy's profiles and the curtain.
        if (k === 'profiles') {
            const p = state.profiles;
            [state.showMeas, state.showModel, state.showDiff] = [p === 'both' || p === 'meas', p === 'both' || p === 'model', p === 'diff'];
            k = 'showMeas';
        } else if (k === 'curtainMode') {
            const turned = state.curtainMode !== 'off' && state.curtainMode !== state.curtainAz;
            state.curtain = state.curtainMode !== 'off';
            if (state.curtain) state.curtainAz = state.curtainMode;
            k = turned ? 'curtainAz' : 'curtain';
        }
        $('[data-v="exag"]').textContent = String(state.exag);
        $('[data-v="exag2"]').textContent = String(state.exag);
        $('[data-v="exagTop"]').textContent = String(state.exag);
        const landx = String(+(state.exag * LAND_RELIEF).toFixed(1));
        $('[data-v="landTop"]').textContent = landx;
        $('[data-v="landx2"]').textContent = landx;
        root.querySelectorAll('[data-leg="curtain"]').forEach((x) => { x.style.display = state.curtain ? '' : 'none'; });
        applyUnits(); // the curtain's line of text names its bearing
        root.querySelectorAll('[data-leg="buoy"]').forEach((x) => { x.style.display = state.buoy ? '' : 'none'; });
        if (!state.ready) return;
        if (k === 'exag') { world.scale.y = state.exag; if (objs.dem.visible) demNormals(); updateBuoy(); }
        else if (k === 'cells' || k === 'layer' || k === 'cellOpacity' || k === 'edges') updateCells();
        else if (k === 'curtain' || k === 'curtainAz') { if (k === 'curtainAz') buildCurtainCrossings(); updateCurtain(); }
        else if (k === 'bed') updateBeds();
        else if (k === 'tracers' || k === 'trailH') updateTracks();
        else if (k === 'buoy' || k === 'buoyDeep') updateBuoy();
        else if (k === 'showMeas' || k === 'showModel' || k === 'showDiff') applyTime();
        if (k === 'edges') updateCurtain();
        needsRender = true;
    }
    onControl('');

    // ---- init ----
    (async () => {
        try {
            const [lib, meshJ, demJ, buoyJ, trkJ, profJ] = await Promise.all([
                loadThree(),
                getJson(joinUrl(dataBase, 'mesh.json')),
                getJson(joinUrl(dataBase, 'dem.json')),
                getJson(joinUrl(dataBase, 'buoy.json')),
                getJson(joinUrl(dataBase, 'tracks.json')),
                getJson(joinUrl(dataBase, 'profile.json')),
            ]);
            profile = profJ;
            if (state.disposed) return;
            const f = meshJ.files;
            const [nodesB, triB, zetaB, uB, vB, demB, trkB, sigB] = await Promise.all([
                getBin(joinUrl(dataBase, f.nodes)), getBin(joinUrl(dataBase, f.tri)),
                getBin(joinUrl(dataBase, f.zeta)), getBin(joinUrl(dataBase, f.u)), getBin(joinUrl(dataBase, f.v)),
                getBin(joinUrl(dataBase, 'dem.bin')), getBin(joinUrl(dataBase, 'tracks.f32')),
                f.siglev ? getBin(joinUrl(dataBase, f.siglev)) : Promise.resolve(null),
            ]);
            if (state.disposed) return;
            THREE = lib.THREE;
            setupData(meshJ, nodesB, triB, zetaB, uB, vB, sigB, demJ, demB, buoyJ, trkJ, trkB);
            setupScene(lib.OrbitControls);
            state.ready = true;
            showMsg('');
            onControl('');
            updateCells(); updateCurtain(); updateBeds(); updateTracks(); updateBuoy();
            applyTime();
            loop();
            if (onReady) onReady({ t0: mesh.times[0], t1: mesh.times[mesh.times.length - 1] });
        } catch (err) {
            console.error(err);
            showMsg(`The 3D view could not load: ${err.message || err}`);
        }
    })();

    // ---- data ----
    function setupData(meshJ, nodesB, triB, zetaB, uB, vB, sigB, demJ, demB, buoyJ, trkJ, trkB) {
        const nd = new Float32Array(nodesB);
        const N = meshJ.nodes, E = meshJ.elements, L = meshJ.layers, T = meshJ.times.length;
        const ex = new Float32Array(N), ny = new Float32Array(N), h = new Float32Array(N);
        for (let i = 0; i < N; i++) { ex[i] = nd[3 * i]; ny[i] = nd[3 * i + 1]; h[i] = nd[3 * i + 2]; }
        let siglev;
        if (meshJ.sigma_uniform) {
            const s = meshJ.siglev;
            siglev = (k) => s[k];
        } else {
            const s = new Float32Array(sigB);
            siglev = (k, i) => s[k * N + i];
        }
        mesh = {
            N, E, L, T, ex, ny, h, siglev, uniform: meshJ.sigma_uniform, levels: meshJ.siglev,
            tri: new Uint16Array(triB), zeta: new Int16Array(zetaB), u: new Int16Array(uB), v: new Int16Array(vB),
            times: meshJ.times, stats: meshJ.stats,
            // Layer-centre sigma for the profile (uniform here; otherwise the mid-level of node 0's column).
            siglay: meshJ.siglay || Array.from({ length: L }, (_, k) => 0.5 * (siglev(k, 0) + siglev(k + 1, 0))),
        };
        // Horizontal speed per element-layer-record, mm/s, from u and v.
        mesh.speed = new Uint16Array(mesh.u.length);
        for (let i = 0; i < mesh.u.length; i++) mesh.speed[i] = Math.min(65535, Math.round(Math.hypot(mesh.u[i], mesh.v[i])));
        // Boundary edges of the displayed subset (sides are drawn only there).
        const cnt = new Map();
        const key = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
        for (let e = 0; e < E; e++) for (let j = 0; j < 3; j++) {
            const k = key(mesh.tri[3 * e + j], mesh.tri[3 * e + (j + 1) % 3]);
            cnt.set(k, (cnt.get(k) || 0) + 1);
        }
        mesh.bEdges = [];
        mesh.edges = [];
        for (let e = 0; e < E; e++) for (let j = 0; j < 3; j++) {
            const a = mesh.tri[3 * e + j], b = mesh.tri[3 * e + (j + 1) % 3];
            if (cnt.get(key(a, b)) === 1) mesh.bEdges.push(e, a, b);
            if (a < b || cnt.get(key(a, b)) === 1) mesh.edges.push(a, b);
        }
        // Element holding the buoy (0, 0), and its barycentric weights, for the surface there.
        for (let e = 0; e < E; e++) {
            const [a, b, c] = [mesh.tri[3 * e], mesh.tri[3 * e + 1], mesh.tri[3 * e + 2]];
            const d = (ny[b] - ny[c]) * (ex[a] - ex[c]) + (ex[c] - ex[b]) * (ny[a] - ny[c]);
            const w1 = ((ny[b] - ny[c]) * (0 - ex[c]) + (ex[c] - ex[b]) * (0 - ny[c])) / d;
            const w2 = ((ny[c] - ny[a]) * (0 - ex[c]) + (ex[a] - ex[c]) * (0 - ny[c])) / d;
            const w3 = 1 - w1 - w2;
            if (w1 >= 0 && w2 >= 0 && w3 >= 0) { mesh.buoyEl = { nodes: [a, b, c], w: [w1, w2, w3] }; break; }
        }
        nec = { rec: -1, zl: null };

        dem = { meta: demJ, z: new Int16Array(demB) };
        // Displayed heights (m MSL, before the scene exaggeration): land above LAND_KNEE compressed.
        dem.zs = new Float32Array(dem.z.length);
        for (let i = 0; i < dem.z.length; i++) {
            const z = dem.z[i] * demJ.scale;
            dem.zs[i] = z > LAND_KNEE ? LAND_KNEE + (z - LAND_KNEE) * LAND_RELIEF : z;
        }
        buoy = { ...buoyJ, rec: -1 };
        $('[data-v="decl"]').textContent = Math.abs(buoyJ.declination_deg).toFixed(1);
        trk = { meta: trkJ, data: new Float32Array(trkB), rec: -1 };
    }

    // Node elevation of sigma level k at record r: siglev * (h + zeta) + zeta.
    function levelZ(r) {
        const { N, L, h, siglev, zeta } = mesh;
        const zl = new Float32Array((L + 1) * N);
        for (let k = 0; k <= L; k++) for (let i = 0; i < N; i++) {
            const z = zeta[r * N + i] / 1000;
            zl[k * N + i] = siglev(k, i) * (h[i] + z) + z;
        }
        return zl;
    }

    // ---- scene ----
    function setupScene(OrbitControls) {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        root.insertBefore(renderer.domElement, root.firstChild);
        renderer.domElement.setAttribute('aria-label', '3D view of currents, tracers and seabed at the Piscataqua River');
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(40, 1, 5, 60000);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.12;
        controls.maxPolarAngle = Math.PI * 0.495;
        controls.minDistance = 150;
        controls.maxDistance = 20000;
        controls.screenSpacePanning = false;
        controls.addEventListener('start', () => { camMoved = true; });
        controls.addEventListener('change', () => { needsRender = true; if (onChange) onChange(); });
        world = new THREE.Group();
        world.scale.y = state.exag;
        scene.add(world);
        const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 1.6);
        const sun = new THREE.DirectionalLight(0xffffff, 1.6);
        sun.position.set(-0.6, 1.0, -0.4);
        scene.add(hemi, sun);
        objs.hemi = hemi; objs.sun = sun;

        buildDem();
        buildNecofsBed();
        buildCurtainCrossings();
        buildTracks();
        buildBuoy();
        applyThemeScene();
        resize();
        ro = new ResizeObserver(() => { resize(); });
        ro.observe(root);
        resetView();
        if (pendingCam) { applyCam(pendingCam); pendingCam = null; }
    }

    function resetView() {
        if (!camera) return;
        const d = narrow() ? 1.7 : 1.0;
        camera.position.set(-3500 * d, 2400 * d, 1700 * d);
        controls.target.set(0, -60, -200);
        controls.update();
        needsRender = true;
    }

    function resize() {
        if (!renderer) return;
        const w = Math.max(1, root.clientWidth), hh = Math.max(1, root.clientHeight);
        renderer.setSize(w, hh, false);
        camera.aspect = w / hh;
        camera.updateProjectionMatrix();
        needsRender = true;
    }

    function loop() {
        raf = requestAnimationFrame(loop);
        const moved = controls.update();
        if (moved || needsRender) {
            renderer.render(scene, camera);
            needsRender = false;
        }
    }

    // ---- DEM ----
    function buildDem() {
        const m = dem.meta, nx = m.nx, nyy = m.ny;
        const pos = new Float32Array(nx * nyy * 3);
        for (let j = 0; j < nyy; j++) {
            const yN = m.y0 + (m.y1 - m.y0) * (j / (nyy - 1));
            for (let i = 0; i < nx; i++) {
                const xE = m.x0 + (m.x1 - m.x0) * (i / (nx - 1));
                const p = (j * nx + i) * 3;
                pos[p] = xE; pos[p + 1] = dem.zs[j * nx + i]; pos[p + 2] = -yN;
            }
        }
        const idx = new Uint32Array((nx - 1) * (nyy - 1) * 6);
        let q = 0;
        for (let j = 0; j < nyy - 1; j++) for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
            idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c;
        }
        const g = track(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nx * nyy * 3), 3));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        // Normals in the exaggerated frame, recomputed when the exaggeration changes.
        const mat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
        objs.dem = new THREE.Mesh(g, mat);
        world.add(objs.dem);
        dem.normalsFor = -1;
    }
    function demNormals() {
        // Lambert shading must see the exaggerated relief, so compute normals on scaled heights.
        if (dem.normalsFor === state.exag) return;
        const g = objs.dem.geometry, m = dem.meta, nx = m.nx, nyy = m.ny;
        const dx = (m.x1 - m.x0) / (nx - 1), dy = (m.y1 - m.y0) / (nyy - 1);
        const nrm = new Float32Array(nx * nyy * 3);
        const s = state.exag;
        // The mesh is scaled by s in y, so the normal in object space is (gx*s, 1, gz*s) before the
        // inverse-transpose; pass object-space normals that come out right after scaling.
        for (let j = 0; j < nyy; j++) for (let i = 0; i < nx; i++) {
            const z = (ii, jj) => dem.zs[Math.min(nyy - 1, Math.max(0, jj)) * nx + Math.min(nx - 1, Math.max(0, ii))];
            const gx = (z(i + 1, j) - z(i - 1, j)) / (2 * dx);
            const gn = (z(i, j + 1) - z(i, j - 1)) / (2 * dy);
            // world normal ~ (-gx*s, 1, gn*s); object normal n_o with n_w = S^-T n_o = (n_o.x, n_o.y/s, n_o.z)
            const p = (j * nx + i) * 3;
            nrm[p] = -gx * s; nrm[p + 1] = s; nrm[p + 2] = gn * s;
        }
        g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        dem.normalsFor = state.exag;
    }
    function demColours() {
        const th = THEMES[state.light ? 'light' : 'dark'];
        const col = objs.dem.geometry.getAttribute('color');
        const z = dem.z, sc = dem.meta.scale;
        const mix = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
        for (let i = 0; i < z.length; i++) {
            const e = z[i] * sc;
            let c;
            if (e < 0) {
                const f = Math.min(1, -e / 25);
                c = f > 0.5 ? mix(th.sea[1], th.sea[0], (f - 0.5) * 2) : mix(th.sea[2], th.sea[1], f * 2);
            } else c = mix(th.land[0], th.land[1], Math.min(1, e / 20));
            col.array[3 * i] = srgbToLinear(c[0] / 255);
            col.array[3 * i + 1] = srgbToLinear(c[1] / 255);
            col.array[3 * i + 2] = srgbToLinear(c[2] / 255);
        }
        col.needsUpdate = true;
    }

    // ---- NECOFS bed (static, faceted) ----
    function buildNecofsBed() {
        const { E, tri, ex, ny, h } = mesh;
        const pos = new Float32Array(E * 9);
        for (let e = 0; e < E; e++) for (let j = 0; j < 3; j++) {
            const i = tri[3 * e + j];
            pos.set([ex[i], -h[i], -ny[i]], e * 9 + j * 3);
        }
        const g = track(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(E * 9), 3));
        const mat = track(new THREE.MeshLambertMaterial({ flatShading: true, side: THREE.DoubleSide, vertexColors: true }));
        objs.nbed = new THREE.Mesh(g, mat);
        const ep = new Float32Array(mesh.edges.length * 3);
        mesh.edges.forEach((i, k) => ep.set([ex[i], -h[i], -ny[i]], k * 3));
        const eg = track(new THREE.BufferGeometry());
        eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
        objs.nbedEdges = new THREE.LineSegments(eg, track(new THREE.LineBasicMaterial({ transparent: true })));
        world.add(objs.nbed, objs.nbedEdges);
    }
    // The model bed is shaded (flat, per facet) and coloured by the bottom layer's speed at the
    // current NECOFS record, one colour per element.
    function nbedColours() {
        if (!objs.nbed) return;
        const { E, L, speed } = mesh;
        const lut = THEMES[state.light ? 'light' : 'dark'].lut;
        const col = objs.nbed.geometry.getAttribute('color');
        for (let e = 0; e < E; e++) {
            let c = null;
            if (nec.rec >= 0) c = 3 * lutIndex(speed[(nec.rec * L + L - 1) * E + e] / 1000);
            for (let j = 0; j < 3; j++) {
                const p = (e * 3 + j) * 3;
                if (c === null) col.array.set([0.3, 0.3, 0.3], p);
                else { col.array[p] = lut[c]; col.array[p + 1] = lut[c + 1]; col.array[p + 2] = lut[c + 2]; }
            }
        }
        col.needsUpdate = true;
    }

    function updateBeds() {
        if (!state.ready) return;
        const showDem = state.bed === 'dem' || state.bed === 'both';
        const showN = state.bed === 'necofs' || state.bed === 'both';
        objs.dem.visible = showDem;
        if (showDem) demNormals();
        objs.nbed.visible = showN;
        objs.nbedEdges.visible = showN && state.edges;
        needsRender = true;
    }

    // ---- NECOFS cells (prisms) ----
    function cellLayers() {
        if (state.cells === 'surface') return [0];
        if (state.cells === 'one') return [Math.min(mesh.L, state.layer) - 1];
        if (state.cells === 'all') return Array.from({ length: mesh.L }, (_, k) => k);
        return [];
    }
    function updateCells() {
        if (!state.ready) return;
        for (const k of ['cells', 'cellEdges']) if (objs[k]) {
            world.remove(objs[k]); objs[k].geometry.dispose(); objs[k].material.dispose(); objs[k] = null;
        }
        const layers = cellLayers();
        if (!layers.length || nec.rec < 0) { needsRender = true; return; }
        const { E, N, L, tri, ex, ny, speed } = mesh;
        const zl = nec.zl, r = nec.rec;
        const lut = THEMES[state.light ? 'light' : 'dark'].lut;
        const all = state.cells === 'all';
        // Per layer: top face of every element; bottom face too unless all layers are drawn (then
        // the next layer's top face is that surface); vertical sides on the subset boundary only.
        const nb = mesh.bEdges.length / 3;
        // A translucent single layer draws its top face only, so the colour is not blended twice.
        const bottoms = !all && state.cellOpacity >= 0.99;
        const perLayer = E * 3 * (bottoms ? 2 : 1) + nb * 6;
        const nv = layers.length * perLayer + (all ? E * 3 : 0);
        const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
        let v = 0;
        const put = (i, k, c) => {
            pos[3 * v] = ex[i]; pos[3 * v + 1] = zl[k * N + i]; pos[3 * v + 2] = -ny[i];
            col[3 * v] = lut[c]; col[3 * v + 1] = lut[c + 1]; col[3 * v + 2] = lut[c + 2];
            v++;
        };
        const cIdx = (e, k) => 3 * lutIndex(speed[(r * L + k) * E + e] / 1000);
        for (const k of layers) {
            for (let e = 0; e < E; e++) {
                const c = cIdx(e, k);
                const a = tri[3 * e], b = tri[3 * e + 1], d = tri[3 * e + 2];
                put(a, k, c); put(b, k, c); put(d, k, c);
                if (bottoms) { put(a, k + 1, c); put(d, k + 1, c); put(b, k + 1, c); }
            }
            for (let q = 0; q < nb; q++) {
                const e = mesh.bEdges[3 * q], a = mesh.bEdges[3 * q + 1], b = mesh.bEdges[3 * q + 2];
                const c = cIdx(e, k);
                put(a, k, c); put(a, k + 1, c); put(b, k, c);
                put(b, k, c); put(a, k + 1, c); put(b, k + 1, c);
            }
        }
        if (all) { // the bed face of the bottom layer
            const k = L - 1;
            for (let e = 0; e < E; e++) {
                const c = cIdx(e, k);
                const a = tri[3 * e], b = tri[3 * e + 1], d = tri[3 * e + 2];
                put(a, k + 1, c); put(d, k + 1, c); put(b, k + 1, c);
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const op = all ? Math.min(0.5, state.cellOpacity * 0.12) : state.cellOpacity;
        const mat = new THREE.MeshBasicMaterial({
            vertexColors: true, side: THREE.DoubleSide, transparent: op < 1, opacity: op,
            depthWrite: !all && op >= 0.99, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
        objs.cells = new THREE.Mesh(g, mat);
        objs.cells.renderOrder = 2;
        world.add(objs.cells);
        if (state.edges) {
            // Element edges on the top face of the top displayed layer and on the bottom face of the bottom one.
            const kt = layers[0], kb = layers[layers.length - 1] + 1;
            const ed = mesh.edges, ep = new Float32Array(ed.length * 6);
            let w = 0;
            for (const kk of [kt, kb]) for (const i of ed) {
                ep[w++] = ex[i]; ep[w++] = zl[kk * N + i]; ep[w++] = -ny[i];
            }
            const eg = new THREE.BufferGeometry();
            eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
            const th = THEMES[state.light ? 'light' : 'dark'];
            objs.cellEdges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
                color: new THREE.Color(...th.edge), transparent: true, opacity: th.edgeAlpha, depthWrite: false,
            }));
            objs.cellEdges.renderOrder = 3;
            world.add(objs.cellEdges);
        }
        needsRender = true;
    }

    // ---- curtain ----
    function buildCurtainCrossings() {
        // Where the line through the buoy at the chosen azimuth crosses each element: two points per
        // crossed element, each on an element edge (node pair and weight), ordered along the line.
        const az = (CURTAIN_AZ[state.curtainAz] * Math.PI) / 180;
        const dx = Math.sin(az), dy = Math.cos(az);
        const { E, tri, ex, ny } = mesh;
        const segs = [];
        for (let e = 0; e < E; e++) {
            const ids = [tri[3 * e], tri[3 * e + 1], tri[3 * e + 2]];
            const f = ids.map((i) => dx * ny[i] - dy * ex[i]); // signed distance from the line
            const pts = [];
            for (let j = 0; j < 3; j++) {
                const a = ids[j], b = ids[(j + 1) % 3], fa = f[j], fb = f[(j + 1) % 3];
                if ((fa < 0 && fb >= 0) || (fa >= 0 && fb < 0)) {
                    const w = fa / (fa - fb);
                    const x = ex[a] + w * (ex[b] - ex[a]), y = ny[a] + w * (ny[b] - ny[a]);
                    pts.push({ a, b, w, s: x * dx + y * dy, x, y });
                }
            }
            if (pts.length === 2) {
                pts.sort((p, q) => p.s - q.s);
                segs.push({ e, p: pts });
            }
        }
        mesh.curtain = segs;
    }
    function updateCurtain() {
        if (!state.ready) return;
        for (const k of ['curtain', 'curtainEdges']) if (objs[k]) {
            world.remove(objs[k]); objs[k].geometry.dispose(); objs[k].material.dispose(); objs[k] = null;
        }
        if (!state.curtain || nec.rec < 0) { needsRender = true; return; }
        const { N, L, E, u: U, v: V } = mesh;
        // Signed current along the line (positive toward the line bearing), diverging scale +-CURTAIN_MAX.
        const az = (CURTAIN_AZ[state.curtainAz] * Math.PI) / 180, sa = Math.sin(az), ca = Math.cos(az);
        const zl = nec.zl, r = nec.rec;
        const th = THEMES[state.light ? 'light' : 'dark'];
        th.dlut = th.dlut || divergingLut(th.diverging);
        const lut = th.dlut;
        const segs = mesh.curtain;
        const pos = new Float32Array(segs.length * L * 18), col = new Float32Array(segs.length * L * 18);
        const z = (p, k) => (1 - p.w) * zl[k * N + p.a] + p.w * zl[k * N + p.b];
        let v = 0;
        const put = (p, k, c) => {
            pos[3 * v] = p.x; pos[3 * v + 1] = z(p, k); pos[3 * v + 2] = -p.y;
            col[3 * v] = lut[c]; col[3 * v + 1] = lut[c + 1]; col[3 * v + 2] = lut[c + 2];
            v++;
        };
        for (const sg of segs) for (let k = 0; k < L; k++) {
            const i = (r * L + k) * E + sg.e;
            const along = (U[i] * sa + V[i] * ca) / 1000;
            const c = 3 * Math.round(Math.min(1, Math.max(0, (along + CURTAIN_MAX) / (2 * CURTAIN_MAX))) * 255);
            const [p, q] = sg.p;
            put(p, k, c); put(p, k + 1, c); put(q, k, c);
            put(q, k, c); put(p, k + 1, c); put(q, k + 1, c);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        objs.curtain = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
            vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
            transparent: true, opacity: CURTAIN_ALPHA, depthWrite: false,
        }));
        objs.curtain.renderOrder = 1;
        world.add(objs.curtain);
        if (state.edges) {
            // Element boundaries (vertical) and every fifth sigma level, plus the surface and the bed.
            const ep = [];
            const lv = [];
            for (let k = 0; k < L; k += 5) lv.push(k);
            lv.push(L);
            for (const sg of segs) {
                const [p, q] = sg.p;
                for (const pt of [p, q]) ep.push(pt.x, z(pt, 0), -pt.y, pt.x, z(pt, L), -pt.y);
                for (const k of lv) ep.push(p.x, z(p, k), -p.y, q.x, z(q, k), -q.y);
            }
            const eg = new THREE.BufferGeometry();
            eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ep), 3));
            const th = THEMES[state.light ? 'light' : 'dark'];
            objs.curtainEdges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
                color: new THREE.Color(...th.edge), transparent: true, opacity: th.edgeAlpha, depthWrite: false,
            }));
            objs.curtainEdges.renderOrder = 3;
            world.add(objs.curtainEdges);
        }
        needsRender = true;
    }

    // ---- tracers ----
    // Trails use the model's teal on the same log speed axis, in the lightness band the particle
    // scales keep clear of the relief: on dark from L* 36 up over a seabed of L* 18 and below, on
    // light from L* 64 down over a seabed of L* 83 and above. Each segment is coloured by its own
    // speed, the horizontal distance between two consecutive track records over the record step.
    const TRAIL_VERT = `
      attribute float aT; attribute float aTEnd; attribute vec3 aCol;
      uniform float uNow; uniform float uFade; uniform float uStep; uniform vec4 uLift; uniform float uAlpha;
      varying vec4 vCol; varying vec2 vXZ;
      void main() {
        float age = uNow - aT;
        float on = (aTEnd <= uNow + 0.5 && age <= uFade) ? 1.0 : 0.0;
        bool newest = aTEnd > uNow - 0.5;   // the segment ending at the current record
        float a = on * (newest ? 1.0 : uAlpha * (1.0 - age / (uFade + 1.0)));
        vec3 c = newest ? mix(aCol, uLift.rgb, uLift.a) : aCol;
        vCol = vec4(c, a);
        vXZ = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`;
    const TRAIL_FRAG = `
      uniform vec4 uBox; varying vec4 vCol; varying vec2 vXZ;
      void main() {
        if (vCol.a < 0.01) discard;
        if (vXZ.x < uBox.x || vXZ.x > uBox.z || -vXZ.y < uBox.y || -vXZ.y > uBox.w) discard;
        gl_FragColor = vCol;
        #include <colorspace_fragment>
      }`;
    function buildTracks() {
        const m = trk.meta, P = m.particles, R = m.records, d = trk.data, step = m.record_step_s;
        trk.segSpeed = new Float32Array(P * R).fill(NaN);
        let ns = 0;
        for (let p = 0; p < P; p++) for (let j = 0; j < R - 1; j++) {
            const i0 = (p * R + j) * 4, i1 = i0 + 4;
            if (isNaN(d[i0]) || isNaN(d[i1])) continue;
            trk.segSpeed[p * R + j] = Math.hypot(d[i1] - d[i0], d[i1 + 1] - d[i0 + 1]) / step;
            ns++;
        }
        const pos = new Float32Array(ns * 6), aT = new Float32Array(ns * 2), aTEnd = new Float32Array(ns * 2);
        trk.segIndex = new Uint32Array(ns);
        let s = 0;
        for (let p = 0; p < P; p++) {
            const rel = m.release_s[m.cohort[p]];
            for (let j = 0; j < R - 1; j++) {
                if (isNaN(trk.segSpeed[p * R + j])) continue;
                const i0 = (p * R + j) * 4, i1 = i0 + 4;
                pos.set([d[i0], d[i0 + 2], -d[i0 + 1], d[i1], d[i1 + 2], -d[i1 + 1]], s * 6);
                aT[2 * s] = rel + j * step; aT[2 * s + 1] = rel + (j + 1) * step;
                aTEnd[2 * s] = aTEnd[2 * s + 1] = rel + (j + 1) * step;
                trk.segIndex[s] = p * R + j;
                s++;
            }
        }
        const g = track(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
        g.setAttribute('aTEnd', new THREE.BufferAttribute(aTEnd, 1));
        g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(ns * 6), 3));
        const b = dem.meta;
        const mat = track(new THREE.ShaderMaterial({
            vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG, transparent: true, depthWrite: false,
            uniforms: {
                uNow: { value: -1e9 }, uFade: { value: 3 * 3600 }, uStep: { value: step },
                uLift: { value: new THREE.Vector4(1, 1, 1, 0.3) }, uAlpha: { value: 0.85 },
                uBox: { value: new THREE.Vector4(b.x0, b.y0, b.x1, b.y1) },
            },
        }));
        objs.trails = new THREE.LineSegments(g, mat);
        objs.trails.renderOrder = 4; // after the translucent cells: seen through the surface film
        objs.trails.frustumCulled = false;
        world.add(objs.trails);
    }
    function trackColours() {
        const th = THEMES[state.light ? 'light' : 'dark'];
        th.tlut = th.tlut || speedLut(th.tracer);
        const lut = th.tlut;
        const col = objs.trails.geometry.getAttribute('aCol');
        for (let s = 0; s < trk.segIndex.length; s++) {
            const c = 3 * lutIndex(trk.segSpeed[trk.segIndex[s]]);
            for (let v = 0; v < 2; v++) {
                col.array[6 * s + 3 * v] = lut[c]; col.array[6 * s + 3 * v + 1] = lut[c + 1]; col.array[6 * s + 3 * v + 2] = lut[c + 2];
            }
        }
        col.needsUpdate = true;
        // The newest segment is lifted towards white on dark and towards ink on light.
        objs.trails.material.uniforms.uLift.value.set(...(state.light ? [0, 0.01, 0.03, 0.35] : [1, 1, 1, 0.35]));
        // Lighter strokes on the light ground, where dark trails over pale cells read as busy.
        objs.trails.material.uniforms.uAlpha.value = state.light ? 0.38 : 0.85;
    }
    function updateTracks() {
        if (!state.ready) return;
        objs.trails.visible = state.tracers && trk.rec >= 0;
        if (objs.trails.visible) {
            objs.trails.material.uniforms.uNow.value = trk.rec * trk.meta.record_step_s;
            objs.trails.material.uniforms.uFade.value = state.trailH * 3600;
        }
        needsRender = true;
    }

    // ---- buoy and model profiles ----
    function textSprite(text, px, anchorRight = false) {
        const th = THEMES[state.light ? 'light' : 'dark'];
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        const font = `600 ${px * 2}px "Josefin Sans", "Futura", "Century Gothic", sans-serif`;
        ctx.font = font;
        const w = Math.ceil(ctx.measureText(text).width) + 16;
        c.width = w; c.height = px * 2 + 16;
        ctx.font = font;
        ctx.fillStyle = th.label;
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 8, c.height / 2);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false });
        const s = new THREE.Sprite(mat);
        const k = narrow() ? 0.017 : 0.024;
        s.scale.set((c.width / c.height) * k, k, 1);
        s.center.set(anchorRight ? 1 : 0, 0.5);
        s.renderOrder = 10;
        return s;
    }
    // Sprite text, size and anchor (true: the text ends at the point, extending left).
    const LABELS = {
        buoyLabel: ['Measured (UNH buoy)', 13, true],
        modelLabel: ['Model (NECOFS, 45 layers)', 13, false],
        diffLabel: ['Model minus measured', 13, false],
        northLabel: ['N', 15, false],
    };
    // Both stacks share the buoy's position: the measured one in front, the model (the buoy element's
    // values, every MODEL_STRIDE-th layer) behind it and fainter.
    const MODEL_STRIDE = 3;
    const ARROW_ALPHA = 0.75, MODEL_ALPHA = 0.5;
    function makeArrow(order) {
        // A solid arrow along +x from the origin: a shaft cylinder and a cone head, each a unit
        // length, scaled per update. Flat colour (no lighting), so the colour is the value. Arrows are
        // translucent and do not write depth, so the stacks never blank each other out; render order
        // decides which stack is drawn over which.
        const grp = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: ARROW_ALPHA });
        const shaft = new THREE.Mesh(objs.shaftGeo, mat);
        const head = new THREE.Mesh(objs.headGeo, mat);
        shaft.renderOrder = head.renderOrder = order;
        grp.add(shaft, head);
        grp.userData = { shaft, head, mat };
        return grp;
    }
    function setArrow(a, speed, dirRad, tv) {
        // speed m/s, dirRad toward (clockwise from north), tv the vertical thickness in scene units.
        const len = Math.max(1, speed * ARROW_M_PER_MS);
        const headLen = Math.min(70, Math.max(len * 0.35, Math.min(len, 18)));
        const shaftLen = Math.max(0.001, len - headLen);
        const { shaft, head } = a.userData;
        shaft.scale.set(shaftLen, tv, 9);
        head.position.x = shaftLen;
        head.scale.set(headLen, tv * 2.2, 26);
        a.rotation.set(0, Math.PI / 2 - dirRad, 0); // shape +x is east; east = sin(dir), north = cos(dir)
    }
    function buildBuoy() {
        objs.buoyGroup = new THREE.Group(); // outside `world`: positions carry the exaggeration themselves
        scene.add(objs.buoyGroup);
        objs.shaftGeo = track(new THREE.CylinderGeometry(0.5, 0.5, 1, 14).rotateZ(-Math.PI / 2).translate(0.5, 0, 0));
        objs.headGeo = track(new THREE.ConeGeometry(0.5, 1, 18).rotateZ(-Math.PI / 2).translate(0.5, 0, 0));
        objs.arrows = [];
        objs.darrows = [];
        for (let c = 0; c < 20; c++) {
            const a = makeArrow(8); objs.arrows.push(a); objs.buoyGroup.add(a);
            const d = makeArrow(9); objs.darrows.push(d); objs.buoyGroup.add(d);
        }
        objs.marrows = [];
        for (let k = 0; k < mesh.L; k += MODEL_STRIDE) {
            const a = makeArrow(7); a.userData.layer = k; objs.marrows.push(a); objs.buoyGroup.add(a);
        }
        const g = track(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        objs.mast = new THREE.Line(g, track(new THREE.LineBasicMaterial({ transparent: true })));
        objs.buoyGroup.add(objs.mast);
        for (const k of Object.keys(LABELS)) { objs[k] = textSprite(...LABELS[k]); scene.add(objs[k]); }
        const el = profile.element;
        profile.nodes = [mesh.tri[3 * el], mesh.tri[3 * el + 1], mesh.tri[3 * el + 2]];
        // Buoy record nearest each model hour, within 5 minutes, or -1.
        profile.pair = mesh.times.map((tm) => {
            const k = latestAtOrBefore(buoy.t, tm);
            let best = -1, bd = 301;
            for (const j of [k, k + 1]) {
                if (j >= 0 && j < buoy.t.length && Math.abs(buoy.t[j] - tm) < bd) { best = j; bd = Math.abs(buoy.t[j] - tm); }
            }
            return best;
        });
    }
    function elementSurface(r) {
        // FVCOM's element values: the mean of the element's three nodes.
        const n = profile.nodes;
        const zeta = n.reduce((a, i) => a + mesh.zeta[r * mesh.N + i] / 1000, 0) / 3;
        const h = n.reduce((a, i) => a + mesh.h[i], 0) / 3;
        return { zeta, h };
    }
    const cellDepth = (c) => BUOY_CELL_TOP + (c + 0.5) * BUOY_CELL_SIZE; // m below the surface
    const buoyVec = (r, c) => {
        const spd = buoy.spd_cm_s[r][c] / 100, dir = (buoy.dir_deg_toward_true[r][c] * Math.PI) / 180;
        return [spd * Math.sin(dir), spd * Math.cos(dir)];
    };
    const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
    function differences(rN) {
        // Model minus measured at each buoy cell, for model record rN: the buoy record nearest the hour
        // within 5 min (flag 1 only), each cell paired with the model layer whose interfaces hold the
        // cell's depth below the moving surface; no pair below the model bed. No interpolation.
        const rB = profile.pair[rN];
        if (rB < 0 || buoy.flag[rB] !== 1) return { rB, rows: null };
        const { zeta, h } = elementSurface(rN);
        const D = h + zeta;
        const lev = (k) => -mesh.siglev(k, profile.nodes[0]) * D; // interface depth below the surface
        const rows = [];
        for (let c = 0; c < 20; c++) {
            const dc = cellDepth(c);
            let k = -1;
            for (let q = 0; q < mesh.L; q++) if (dc >= lev(q) && dc < lev(q + 1)) { k = q; break; }
            if (k < 0) { rows.push({ c, k: -1 }); continue; }
            const [ub, vb] = buoyVec(rB, c);
            const um = profile.u_mm_s[rN][k] / 1000, vm = profile.v_mm_s[rN][k] / 1000;
            const du = um - ub, dv = vm - vb;
            const angM = (Math.atan2(um, vm) * 180) / Math.PI, angB = (Math.atan2(ub, vb) * 180) / Math.PI;
            rows.push({ c, k, du, dv, mag: Math.hypot(du, dv), dAng: wrap180(angM - angB), depth: dc });
        }
        return { rB, rows };
    }
    let profStatus = '';
    function updateBuoy() {
        if (!state.ready) return;
        const th = THEMES[state.light ? 'light' : 'dark'];
        const s = state.exag;
        const rN = nec.rec;
        const on = state.buoy;
        const showMeas = on && state.showMeas;
        const showModel = on && rN >= 0 && state.showModel;
        const showDiff = on && rN >= 0 && state.showDiff;
        const surf = rN >= 0 ? elementSurface(rN) : { zeta: 0, h: 10 };
        th.tlut = th.tlut || speedLut(th.tracer);
        const tlut = th.tlut;
        // Mast at the buoy from above the surface to the measured bed.
        const mp = objs.mast.geometry.getAttribute('position');
        mp.array.set([0, (surf.zeta + 14) * s, 0, 0, BUOY_BED * s, 0]);
        mp.needsUpdate = true;
        objs.mast.geometry.computeBoundingSphere();
        objs.mast.material.color.set(measuredColour(0.5, state.light));
        objs.mast.visible = on;
        // Labels on either side of the mast top: measured to the left, model (or difference) to the right.
        const ly = (surf.zeta + 15) * s;
        objs.buoyLabel.position.set(-12, ly, 0);
        objs.buoyLabel.visible = showMeas;
        objs.modelLabel.position.set(12, ly, 0);
        objs.modelLabel.visible = showModel;
        objs.diffLabel.position.set(12, ly, 0);
        objs.diffLabel.visible = showDiff;
        objs.northLabel.position.set(-8, 0, -(dem.meta.y1 + 120));
        const tvB = Math.min(12, Math.max(1, 0.45 * BUOY_CELL_SIZE * s));
        // Measured: one arrow per cell, hanging from the model surface at the buoy; true north.
        const r = buoy.rec;
        const flag = r >= 0 ? buoy.flag[r] : 0;
        for (let c = 0; c < 20; c++) {
            const a = objs.arrows[c];
            const deep = c >= BUOY_GOOD_CELLS;
            a.visible = showMeas && r >= 0 && (!deep || state.buoyDeep);
            if (!a.visible) continue;
            const [ub, vb] = buoyVec(r, c);
            const spd = Math.hypot(ub, vb);
            a.position.set(0, (surf.zeta - cellDepth(c)) * s, 0);
            setArrow(a, spd, Math.atan2(ub, vb), tvB);
            a.userData.mat.color.set(measuredColour(spd, state.light));
            a.userData.mat.opacity = deep || flag !== 1 ? 0.3 : ARROW_ALPHA;
        }
        // Model: every MODEL_STRIDE-th layer centre, z = siglay * (h + zeta) + zeta. At the buoy it is
        // drawn first and fainter, so the measured stack reads in front.
        const D = surf.h + surf.zeta;
        const tvM = Math.min(12, Math.max(1, 0.45 * (MODEL_STRIDE * D / mesh.L) * s));
        for (const a of objs.marrows) {
            a.visible = showModel;
            if (!a.visible) continue;
            const k = a.userData.layer;
            const u = profile.u_mm_s[rN][k] / 1000, v = profile.v_mm_s[rN][k] / 1000;
            const spd = Math.hypot(u, v);
            a.position.set(0, (mesh.siglay[k] * D + surf.zeta) * s, 0);
            setArrow(a, spd, Math.atan2(u, v), tvM);
            const c = 3 * lutIndex(spd);
            a.userData.mat.color.setRGB(tlut[c], tlut[c + 1], tlut[c + 2]);
            a.userData.mat.opacity = showMeas ? MODEL_ALPHA : ARROW_ALPHA;
        }
        // Difference: model minus measured at each buoy cell, in the theme's ink.
        profStatus = '';
        let diff = null;
        if (showDiff) {
            diff = differences(rN);
            profStatus = diff.rows
                ? `<b>Difference</b> at ${fmtUtc(mesh.times[rN]).replace(/^\w+ \d+ /, '').replace(' UTC', '')}, buoy ${fmtUtc(buoy.t[diff.rB]).replace(/^\w+ \d+ /, '')}`
                : `<b>Difference</b> none at ${fmtUtc(mesh.times[rN]).replace(/^\w+ \d+ /, '')} (no unflagged buoy record within 5 min)`;
        }
        for (let c = 0; c < 20; c++) {
            const a = objs.darrows[c];
            const row = diff && diff.rows ? diff.rows[c] : null;
            a.visible = !!(row && row.k >= 0 && (c < BUOY_GOOD_CELLS || state.buoyDeep));
            if (!a.visible) continue;
            a.position.set(0, (surf.zeta - cellDepth(c)) * s, 0);
            setArrow(a, row.mag, Math.atan2(row.du, row.dv), tvB);
            a.userData.mat.color.set(diffColour(row.mag, state.light));
            a.userData.mat.opacity = c >= BUOY_GOOD_CELLS ? 0.25 : DIFF_ALPHA;
        }
        renderDiffTable(diff);
        needsRender = true;
    }
    function renderDiffTable(diff) {
        const box = $('[data-diff]');
        if (!box) return;
        box.style.display = state.buoy && state.showDiff ? '' : 'none';
        const tb = box.querySelector('tbody');
        if (!diff || !diff.rows) { tb.innerHTML = '<tr><td colspan="4">No pair at this hour</td></tr>'; return; }
        tb.innerHTML = diff.rows
            .filter((w) => w.c < BUOY_GOOD_CELLS || state.buoyDeep)
            .map((w) => (w.k < 0
                ? `<tr><td>${w.c + 1}</td><td>below model bed</td><td></td><td></td></tr>`
                : `<tr><td>${w.c + 1}</td><td>${w.k + 1}</td><td>${(w.mag * unitOf().f).toFixed(2)}</td><td>${w.dAng >= 0 ? '+' : ''}${w.dAng.toFixed(0)}</td></tr>`))
            .join('');
    }
    function focusBuoy() {
        // From across the channel (bearing 252 deg, looking 72 deg) and 18 deg up, framing the stacks at
        // the buoy: arrows along the channel read at full length.
        if (!camera) return;
        const s = state.exag;
        const tgt = new THREE.Vector3(0, -5 * s, 0);
        const b = (252 * Math.PI) / 180, dist = narrow() ? 2400 : 1400, el = (18 * Math.PI) / 180;
        camera.position.set(tgt.x + Math.sin(b) * dist * Math.cos(el), tgt.y + dist * Math.sin(el), tgt.z - Math.cos(b) * dist * Math.cos(el));
        controls.target.copy(tgt);
        controls.update();
        needsRender = true;
    }

    // ---- theme ----
    function applyThemeScene() {
        const th = THEMES[state.light ? 'light' : 'dark'];
        th.lut = th.lut || speedLut(th.ramp);
        scene.background = new THREE.Color(th.bg);
        objs.hemi.intensity = state.light ? 1.9 : 1.4;
        objs.sun.intensity = state.light ? 1.3 : 1.6;
        demColours();
        nbedColours();
        objs.nbedEdges.material.color.setRGB(...th.edge);
        objs.nbedEdges.material.opacity = th.edgeAlpha;
        trackColours();
        for (const k of Object.keys(LABELS)) {
            const old = objs[k];
            const fresh = textSprite(...LABELS[k]);
            fresh.position.copy(old.position);
            fresh.visible = old.visible;
            scene.remove(old); old.material.map.dispose(); old.material.dispose();
            objs[k] = fresh; scene.add(fresh);
        }
    }
    // ---- time ----
    function applyTime() {
        if (!state.ready) return;
        const t = state.t;
        const parts = [];
        // NECOFS: hourly records.
        const rN = t == null ? -1 : latestAtOrBefore(mesh.times, t);
        if (rN !== nec.rec) {
            nec.rec = rN;
            nec.zl = rN >= 0 ? levelZ(rN) : null;
            updateCells(); updateCurtain(); nbedColours();
        }
        parts.push(`<b>NECOFS</b> ${rN >= 0 ? fmtUtc(mesh.times[rN]) : 'no record yet'}`);
        // Buoy: 10-minute records.
        const rB = t == null ? -1 : latestAtOrBefore(buoy.t, t);
        buoy.rec = rB;
        const fl = rB >= 0 ? buoy.flag[rB] : 0;
        const flagTxt = fl === 1 ? '' : fl === 3 ? ', flag 3 suspect' : fl === 4 ? ', flag 4 fail' : '';
        parts.push(`<b>Buoy</b> ${rB >= 0 ? fmtUtc(buoy.t[rB]).replace(/^\w+ \d+ /, '') + flagTxt : 'no record yet'}`);
        updateBuoy();
        // Tracks: their own record step from the track t0.
        const m = trk.meta;
        const kT = t == null ? -1 : Math.floor((t - m.t0) / m.record_step_s);
        const lastK = Math.round((mesh.times[mesh.times.length - 1] - m.t0) / m.record_step_s);
        trk.rec = kT < 0 ? -1 : Math.min(kT, lastK);
        parts.push(`<b>Tracks</b> ${trk.rec >= 0 ? fmtUtc(m.t0 + trk.rec * m.record_step_s).replace(/^\w+ \d+ /, '') : 'no record yet'}`);
        updateTracks();
        if (profStatus) parts.push(profStatus);
        // Outside the window one plain line replaces the per-source times (which would all read the same).
        const t0 = mesh.times[0], t1 = mesh.times[mesh.times.length - 1];
        const inWindow = t != null && t >= t0 && t <= t1 + 3600;
        const day = (x) => fmtUtc(x).replace(/ \d\d:\d\d UTC$/, '');
        statusEl.innerHTML = inWindow || t == null ? parts.join(' &nbsp;|&nbsp; ')
            : `<span class="pqp-out">3D data cover ${day(t0)} to ${day(t1)} UTC; ${t < t0 ? 'nothing to show yet' : 'showing their last hour'}.</span>`;
        needsRender = true;
    }

    // ---- public API ----
    return {
        setTime(t) {
            if (state.disposed || typeof t !== 'number' || !isFinite(t)) return;
            state.t = t;
            applyTime();
        },
        setUnits(u) {
            if (state.disposed || !(u in UNITS)) return;
            unit = u;
            applyUnits();
            if (state.ready) applyTime(); // the difference table
        },
        /** The panel's choices and the camera ([x, y, z] of the eye and of its target, scene metres), for a link. */
        getState() {
            const s = {};
            for (const k of PANEL_KEYS) s[k] = state[k];
            const c = !camera ? pendingCam
                : camMoved ? [camera.position.x, camera.position.y, camera.position.z, controls.target.x, controls.target.y, controls.target.z] : null;
            if (c) s.cam = c.map((v) => Math.round(v));
            return s;
        },
        /** Restore what getState returned (any part of it); unknown or invalid values are ignored. */
        setState(s) {
            if (state.disposed || !s) return;
            for (const k of PANEL_KEYS) {
                if (s[k] === undefined) continue;
                const inp = root.querySelector(`[data-k="${k}"]`);
                if (!inp) continue;
                if (inp.type === 'checkbox') { state[k] = !!s[k]; inp.checked = state[k]; }
                else if (inp.type === 'range') {
                    const v = Number(s[k]);
                    if (!Number.isFinite(v)) continue;
                    state[k] = Math.min(Number(inp.max), Math.max(Number(inp.min), v));
                    inp.value = String(state[k]);
                } else {
                    if (![...inp.options].some((o) => o.value === String(s[k]))) continue;
                    state[k] = String(s[k]);
                    inp.value = state[k];
                }
                onControl(k);
            }
            if (Array.isArray(s.cam) && s.cam.length === 6 && s.cam.every(Number.isFinite)) {
                if (camera) applyCam(s.cam);
                else pendingCam = s.cam.slice();
            }
        },
        timeRange() {
            return mesh ? { t0: mesh.times[0], t1: mesh.times[mesh.times.length - 1] } : null;
        },
        setTheme(light) {
            if (state.disposed) return;
            state.light = !!light;
            // Default surface-cell opacity per theme (lower on light), until the viewer sets it.
            state.cellOpacity = state.light ? 0.15 : 0.3;
            applyThemeCss();
            if (!state.ready) return;
            applyThemeScene();
            updateCells(); updateCurtain(); updateTracks(); updateBuoy();
            needsRender = true;
        },
        dispose() {
            if (state.disposed) return;
            state.disposed = true;
            cancelAnimationFrame(raf);
            if (ro) ro.disconnect();
            if (controls) controls.dispose();
            if (scene) {
                scene.traverse((o) => {
                    if (o.geometry) o.geometry.dispose();
                    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
                    for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); }
                });
            }
            for (const d of disposables) if (d && d.dispose) d.dispose();
            if (renderer) {
                renderer.dispose();
                renderer.forceContextLoss();
            }
            root.remove();
            mesh = nec = dem = trk = buoy = profile = null;
        },
    };
}
