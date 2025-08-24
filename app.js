// app.js — main thread: UI, hidden water-probe, drawing tools, worker orchestration
// What this file does (plain English):
// - Boots a Mapbox map you can draw on
// - Keeps a hidden zoomed-in map off-screen to quickly check “is this pixel water?”
// - Shows/updates a JSON panel with your drawing
// - Sends routing jobs to a Web Worker and draws the returned route
// - Handles tricky 180° dateline cases by splitting lines into safe segments

// -----------------------------------------------------------------------------
// REQUIREMENTS (index.html):
//   <script type="module" src="/app.js"></script>
//   http://184.72.204.18:8000/
//   pk.eyJ1IjoiNTlub3J0aGx0ZCIsImEiOiJjbWFvbWJ3cWkwOHYyMmxwdng0a3U3Y3hwIn0.foCCShBlTgCQ1rzTL85KFg
//   https://dgme6gz9k7dme.cloudfront.net/land_mask.json
// -----------------------------------------------------------------------------

import { initDrawingTools } from './drawing-tools.js';
import * as turf from 'https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/+esm';
import * as h3 from 'https://cdn.jsdelivr.net/npm/h3-js@3.7.2/+esm';
import BloomPkg from 'https://esm.sh/bloom-filters@3.0.4';
const { BloomFilter } = BloomPkg;

// ========= CONFIG =========
// Where the land mask is, H3 resolution to use, how much to buffer land,
// and the zoom level the hidden map uses for quick water checks.
const LAND_BLOOM_URL = 'https://dgme6gz9k7dme.cloudfront.net/land-h3-r6-k1.bloom.json';
const H3_RES = 6;
const DILATE_K = 1;
const WATER_Z = 13;
// =========================

mapboxgl.accessToken = 'pk.eyJ1IjoiNTlub3J0aGx0ZCIsImEiOiJjbWFvbWJ3cWkwOHYyMmxwdng0a3U3Y3hwIn0.foCCShBlTgCQ1rzTL85KFg';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: [-40, 30],
    zoom: 2
});

// Hidden high-zoom map for water checks 
// Used to very quickly ask is this location painted as water at high zoom?
const hiDiv = document.createElement('div');
hiDiv.id = 'hiMap';
hiDiv.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:512px;height:512px;';
document.body.appendChild(hiDiv);

const mapHi = new mapboxgl.Map({
    container: hiDiv,
    style: 'mapbox://styles/mapbox/light-v11',
    center: [0, 0],
    zoom: WATER_Z,
    interactive: false
});

let waterReady = false;
mapHi.on('load', () => { waterReady = true; });

/** Checks the hidden map to see if a point is water (true), land (false), or not ready (null). */
function isWaterRendered(lng, lat) {
    if (!waterReady) return null;
    const pt = mapHi.project([lng, lat]);
    const feats = mapHi.queryRenderedFeatures(pt, { layers: ['water'] });
    return feats.length > 0;
}
window.isWaterRendered = isWaterRendered;

const $ = id => document.getElementById(id);
const setStatus = msg => { const el = $('toolsStatus'); if (el) el.textContent = msg; };

/** Expands a map bounds box by a percentage so the view isnt too tight. */
function padBounds(bounds, ratio = 0.15) {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const dLon = ne.lng - sw.lng;
    const dLat = ne.lat - sw.lat;
    const padLon = dLon * ratio;
    const padLat = dLat * ratio;
    return new mapboxgl.LngLatBounds(
        [sw.lng - padLon, sw.lat - padLat],
        [ne.lng + padLon, ne.lat + padLat]
    );
}

/** Fits the main map to a set of points, handling the 180 dateline */
function fitMainMapDatelineSafe(pts /* [[lng,lat], ...] */) {
    if (!pts.length) return;
    const ref = pts[0][0];
    const unwrapped = pts.map(([lng, lat]) => [unwrapLng(lng, ref), lat]);
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of unwrapped) {
        if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    const padLng = (maxLng - minLng) * 0.15, padLat = (maxLat - minLat) * 0.15;
    const b = new mapboxgl.LngLatBounds(
        [minLng - padLng, minLat - padLat],
        [maxLng + padLng, maxLat + padLat]
    );
    map.fitBounds(b, { padding: 80, duration: 0 });
}

// --------- Dateline-safe helpers for hidden hi map ---------

/** Keeps a longitude close to a reference value (prevents jumps around 180) */
function unwrapLng(lng, ref) {
    let x = lng;
    while (x - ref > 180) x -= 360;
    while (ref - x > 180) x += 360;
    return x;
}

/** Splits a long line into pieces when it would otherwise cross the dateline the long way */
function segmentsSplitOnDateline(pts /* [{lng,lat}, ...] */) {
    if (!pts || pts.length < 2) return [pts || []];
    const segs = [];
    let cur = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1], p = pts[i];
        const dλ = Math.abs(p.lng - prev.lng);
        if (dλ > 180) {         // break so the renderer doesn’t wrap the long way
            segs.push(cur);
            cur = [p];
        } else {
            cur.push(p);
        }
    }
    if (cur.length) segs.push(cur);
    return segs;
}

/** Fits the hidden hi-zoom map to a list of sample points for quick water checks */
function fitHiMapToSamples(samples) {
    if (!samples.length) return;
    const ref = samples[0][0];
    const unwrapped = samples.map(([lng, lat]) => [unwrapLng(lng, ref), lat]);
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of unwrapped) {
        if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    const padLng = (maxLng - minLng) * 0.15, padLat = (maxLat - minLat) * 0.15;
    const b = new mapboxgl.LngLatBounds(
        [minLng - padLng, minLat - padLat],
        [maxLng + padLng, maxLat + padLat]
    );
    mapHi.fitBounds(b, { padding: 32, duration: 0 });
}

// ----------------- Worker setup -----------------

/** Starts (or reuses) the Web Worker that performs the heavy routing work. */
let routeWorker = null;
function ensureWorker() {
    if (routeWorker) return routeWorker;
    const workerUrl = new URL('./autoroute.worker.js', import.meta.url);
    routeWorker = new Worker(workerUrl, { type: 'module' });
    routeWorker.onmessage = (ev) => {
        const { type } = ev.data || {};
        if (type === 'inited') { setStatus('Land mask ready (worker).'); return; }
        if (type === 'started') { setStatus(`Routing on water (worker)… (${ev.data.segments} segment${ev.data.segments === 1 ? '' : 's'})`); return; }
    };
    routeWorker.onerror = (e) => { console.error('Worker crashed:', e.message || e); alert(`Autoroute worker crashed: ${e.message || e}`); };
    routeWorker.onmessageerror = (e) => { console.error('Worker message clone error:', e); alert('Autoroute worker could not transfer the result (clone error).'); };
    return routeWorker;
}

/** Sends a routing request to the worker and resolves with the route GeoJSON or errors */
function requestRouteWithWorker(pts, opts) {
    const w = ensureWorker();
    return new Promise((resolve, reject) => {
        const timeoutMs = 450000;
        const timer = setTimeout(() => { w.removeEventListener('message', onMsg); reject(new Error('Worker timeout (no response)')); }, timeoutMs);
        const onMsg = (ev) => {
            const { type } = ev.data || {};
            if (type === 'route') { clearTimeout(timer); w.removeEventListener('message', onMsg); resolve(ev.data.route); }
            else if (type === 'error') { clearTimeout(timer); w.removeEventListener('message', onMsg); reject(new Error(ev.data.message)); }
            else if (type === 'started') { setStatus(`Routing on water (worker)… (${ev.data.segments} segment${ev.data.segments === 1 ? '' : 's'})`); }
        };
        w.addEventListener('message', onMsg);
        w.postMessage({ type: 'route', pts, opts });
    });
}

// ----------------- App wiring -----------------
map.on('load', async () => {
    // Sets up draw tools, JSON panel wiring, and loads the land mask Bloom filter.
    const api = initDrawingTools(map);
    const wrap = $('jsonWrap'), tab = $('jsonTab'), txt = $('jsonText');
    const btnCopy = $('btnCopyJson'), btnDl = $('btnDownloadJson');
    const btnClear = $('btnClearJson');

    /** Writes the current drawing as formatted JSON into the panel. */
    const render = (fc = api.getFeatureCollection()) => { if (txt) txt.value = JSON.stringify(fc, null, 2); };
    render();

    // Panel open/close + keep JSON in sync when opened
    tab?.addEventListener('click', () => {
        wrap.classList.toggle('open');
        tab.setAttribute('aria-expanded', wrap.classList.contains('open'));
        if (wrap.classList.contains('open')) render();
    });

    // Copy JSON button
    btnCopy?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(txt.value); btnCopy.textContent = 'Copied!'; setTimeout(() => btnCopy.textContent = 'Copy', 900); }
        catch { alert('Copy failed'); }
    });

    // Download JSON button
    btnDl?.addEventListener('click', () => {
        const blob = new Blob([txt.value], { type: 'application/geo+json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'drawing.geojson'; a.click();
        URL.revokeObjectURL(a.href);
    });

    /** Clears both the map features and the JSON panel in one go. */
    function clearGeojsonPanel() {
        const emptyFC = { type: 'FeatureCollection', features: [] };
        api.setFeatureCollection(emptyFC);
        render(emptyFC);
        setStatus('Cleared.');
    }

    // Wire Clear button. 
    ['btnClearJson', 'btnClear'].forEach(id => {
        const el = $(id);
        if (el) {
            el.addEventListener('click', (e) => { e.preventDefault(); clearGeojsonPanel(); });
        }
    });
    document.addEventListener('click', (e) => {
        const t = e.target;
        if (t && (t.id === 'btnClearJson' || t.id === 'btnClear' || t.matches?.('[data-action="clear-json"]'))) {
            e.preventDefault();
            clearGeojsonPanel();
        }
    });

    // Load the land mask Bloom filter and expose an isLand helper.
    setStatus('Loading land mask…');
    const t0 = performance.now();
    const bloomJSON = await (await fetch(LAND_BLOOM_URL, { headers: { Accept: 'application/json' } })).json();
    const landBF = BloomFilter.fromJSON(bloomJSON);
    window.h3 = h3; window.landBF = landBF;

    const hasLandCell = (h) => landBF.has(h);
    const isBlockedCell = (cell) => {
        if (hasLandCell(cell)) return true;
        if (DILATE_K > 0) for (const nb of h3.kRing(cell, DILATE_K)) if (hasLandCell(nb)) return true;
        return false;
    };
    const isLand = (p) => {
        const lng = Array.isArray(p) ? p[0] : p.lng;
        const lat = Array.isArray(p) ? p[1] : p.lat;
        const cell = h3.geoToH3(lat, lng, H3_RES);
        return isBlockedCell(cell);
    };
    Object.assign(window, { isLand });

    ensureWorker().postMessage({ type: 'init', bloomJSON });
    setStatus(`Land mask ready (${Math.round(performance.now() - t0)} ms).`);

    // Autoroute button asks worker for a water only route, then renders the result.
    document.getElementById('btnAutoroute')?.addEventListener('click', async () => {
        try {
            const fc = api.getFeatureCollection();
            const pts = fc.features
                .filter(f => f.geometry?.type === 'Point')
                .map(f => /** @type {[number,number]} */(f.geometry.coordinates));

            if (pts.length < 2) {
                alert('Add at least two Points, then click Autoroute.');
                return;
            }

            fitMainMapDatelineSafe(pts);
            setStatus('Routing on water (worker)…');

            // Fit the hidden map to a GC chord between first two points (improves water checks)
            const chord = chordSamples(pts[0][0], pts[0][1], pts[1][0], pts[1][1], 80);
            fitHiMapToSamples(chord);
            await new Promise(res => {
                if (!waterReady) mapHi.once('load', () => mapHi.once('idle', res));
                else mapHi.once('idle', res);
            });

            // If the straight line obviously hits land, pre mark those nearby cells as land overrides
            let landOverrides = [];
            if (pts.length === 2 && chordCrossesLandViaTiles(pts[0], pts[1])) {
                landOverrides = chordCellsFromTiles(pts[0], pts[1], 20, 2);
                console.log('landOverrides (chord) cells:', landOverrides.length);
            }

            // Ask the worker for a route
            const route = await requestRouteWithWorker(pts, {
                h3Res: H3_RES,
                dilateKRings: DILATE_K,
                padDeg: 3.0,
                sampleMeters: 400,
                corridorStepDeg: 0.12,
                landOverrides
            });

            const coords = route?.geometry?.coordinates || [];
            if (coords.length < 2) {
                setStatus('No water-only route found.');
                alert('No water-only route found.');
                return;
            }

            // Split the route so it draws correctly across the 180 line
            const ptsLL = coords.map(([lng, lat]) => ({ lng, lat }));
            const segs = segmentsSplitOnDateline(ptsLL);

            // Build one LineString per segment and add to the current drawing
            const segFeatures = segs.map((seg, idx) => ({
                type: 'Feature',
                properties: { ...(route.properties || {}), kind: 'autoroute', segment: idx },
                geometry: { type: 'LineString', coordinates: seg.map(p => [p.lng, p.lat]) }
            }));

            const next = { ...fc, features: [...fc.features, ...segFeatures] };
            api.setFeatureCollection(next);
            render(next);

            // Show total distance in nautical miles
            try {
                const km = segFeatures.reduce((sum, f) => sum + turf.length(f, { units: 'kilometers' }), 0);
                const nm = km * 0.539957;
                setStatus(`Route length: ${nm.toFixed(1)} nm`);
                console.log('[autoroute] length km:', km.toFixed(3), 'nm:', nm.toFixed(3));
            } catch (e) {
                console.warn('length calc failed', e);
                setStatus('Route ready.');
            }

        } catch (err) {
            console.error(err);
            setStatus('Error while routing.');
        }
    });

    // --------- Dateline-safe chord sampler for tile probes ---------

    /** Generates evenly spaced points along the great-circle between two lon/lat coords. */
    function chordSamples(lngA, latA, lngB, latB, stepKm = 30) {
        const R = 6371;
        const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
        const φ1 = toRad(latA), λ1 = toRad(lngA);
        const φ2 = toRad(latB), λ2 = toRad(lngB);
        const dφ = φ2 - φ1, dλ = λ2 - λ1;
        const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
        const δ = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
        if (δ === 0) return [[lngA, latA], [lngB, latB]];
        const distKm = R * δ;
        const n = Math.max(1, Math.ceil(distKm / stepKm));
        const sinδ = Math.sin(δ);
        const x1 = Math.cos(φ1) * Math.cos(λ1), y1 = Math.cos(φ1) * Math.sin(λ1), z1 = Math.sin(φ1);
        const x2 = Math.cos(φ2) * Math.cos(λ2), y2 = Math.cos(φ2) * Math.sin(λ2), z2 = Math.sin(φ2);
        const out = [];
        for (let i = 0; i <= n; i++) {
            const f = i / n;
            const A1 = Math.sin((1 - f) * δ) / sinδ, B1 = Math.sin(f * δ) / sinδ;
            const x = A1 * x1 + B1 * x2, y = A1 * y1 + B1 * y2, z = A1 * z1 + B1 * z2;
            const φ = Math.atan2(z, Math.hypot(x, y));
            const λ = Math.atan2(y, x);
            out.push([((toDeg(λ) + 540) % 360) - 180, toDeg(φ)]);
        }
        return out;
    }

    /** Quick pre check for speed: does the straight line between A and B hit land (per the hidden map)? */
    function chordCrossesLandViaTiles(A, B) {
        const samples = chordSamples(A[0], A[1], B[0], B[1], 40);
        for (const [lng, lat] of samples) {
            const w = isWaterRendered(lng, lat);
            if (w === false) return true;
        }
        return false;
    }

    /** Creates a set of nearby land hex cells along the chord (to bias routing away) */
    function chordCellsFromTiles(A, B, stepKm = 20, ring = 2) {
        const pts = chordSamples(A[0], A[1], B[0], B[1], stepKm);
        const cells = new Set();
        for (const [lng, lat] of pts) {
            const w = isWaterRendered(lng, lat);
            if (w === false) {
                const c = h3.geoToH3(lat, lng, H3_RES);
                cells.add(c);
                for (const nb of h3.kRing(c, ring)) cells.add(nb);
            }
        }
        return Array.from(cells);
    }
});
