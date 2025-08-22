// app.js
// ─────────────────────────────────────────────────────────────────────────────
// REQUIREMENTS (index.html):
//   <script type="module" src="/app.js"></script>
//   http://184.72.204.18:8000/
//   pk.eyJ1IjoiNTlub3J0aGx0ZCIsImEiOiJjbWFvbWJ3cWkwOHYyMmxwdng0a3U3Y3hwIn0.foCCShBlTgCQ1rzTL85KFg
//   https://dgme6gz9k7dme.cloudfront.net/land_mask.json
// ─────────────────────────────────────────────────────────────────────────────

// app.js — uses Bloom land set + H3 A* router with land dilation
import { initDrawingTools } from './drawing-tools.js';
import { autoroute, nudgeOffshore } from './autoroute.js?v=h3astar1';
import * as turf from 'https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/+esm';
import * as h3 from 'https://cdn.jsdelivr.net/npm/h3-js@3.7.2/+esm';
import BloomPkg from 'https://esm.sh/bloom-filters@3.0.4';
const { BloomFilter } = BloomPkg;

// ========= CONFIG =========
const LAND_BLOOM_URL = 'https://dgme6gz9k7dme.cloudfront.net/land-h3-r6-k1.bloom.json';
const H3_RES = 6;             // hex resolution for routing
const DILATE_K = 1;           // treat land dilated by 1 ring (= conservative)
// =========================

mapboxgl.accessToken = 'pk.eyJ1IjoiNTlub3J0aGx0ZCIsImEiOiJjbWFvbWJ3cWkwOHYyMmxwdng0a3U3Y3hwIn0.foCCShBlTgCQ1rzTL85KFg';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: [-40, 30],
    zoom: 2
});

const $ = id => document.getElementById(id);
const setStatus = msg => { const el = $('toolsStatus'); if (el) el.textContent = msg; };

map.on('load', async () => {
    // Draw tools + right JSON panel
    const api = initDrawingTools(map);

    const wrap = $('jsonWrap');
    const tab = $('jsonTab');
    const txt = $('jsonText');
    const btnCopy = $('btnCopyJson');
    const btnDl = $('btnDownloadJson');

    const render = (fc = api.getFeatureCollection()) => { if (txt) txt.value = JSON.stringify(fc, null, 2); };
    render();

    tab?.addEventListener('click', () => {
        wrap.classList.toggle('open');
        tab.setAttribute('aria-expanded', wrap.classList.contains('open'));
        if (wrap.classList.contains('open')) render();
    });
    btnCopy?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(txt.value); btnCopy.textContent = 'Copied!'; setTimeout(() => btnCopy.textContent = 'Copy', 900); }
        catch { alert('Copy failed'); }
    });
    btnDl?.addEventListener('click', () => {
        const blob = new Blob([txt.value], { type: 'application/geo+json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'drawing.geojson';
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // Load Bloom land mask (H3 r=6, with k=1 already baked in server-side)
    setStatus('Loading land mask…');
    const t0 = performance.now();
    const bloomJSON = await (await fetch(LAND_BLOOM_URL, { headers: { Accept: 'application/json' } })).json();
    const landBF = BloomFilter.fromJSON(bloomJSON);

    // Minimal helpers exposed for console sanity checks
    window.h3 = h3;
    window.landBF = landBF;

    // Low-level—check raw cell membership (used by router)
    const hasLandCell = (h) => landBF.has(h);

    // High-level point checker (dilated by DILATE_K rings for extra safety)
    const isLand = (p) => {
        const lng = Array.isArray(p) ? p[0] : p.lng;
        const lat = Array.isArray(p) ? p[1] : p.lat;
        const cell = h3.geoToH3(lat, lng, H3_RES);
        if (hasLandCell(cell)) return true;
        if (DILATE_K > 0) {
            for (const nb of h3.kRing(cell, DILATE_K)) if (hasLandCell(nb)) return true;
        }
        return false;
    };

    Object.assign(window, { isLand });

    setStatus(`Land mask ready (${Math.round(performance.now() - t0)} ms).`);

    // Autoroute button
    $('btnAutoroute')?.addEventListener('click', async () => {
        try {
            const fc = api.getFeatureCollection();
            const pts = fc.features
                .filter(f => f.geometry?.type === 'Point')
                .map(f => /** @type {[number,number]} */(f.geometry.coordinates));

            if (pts.length < 2) return alert('Add at least two Points, then click Autoroute.');

            // View
            const bb = new mapboxgl.LngLatBounds(pts[0], pts[0]);
            for (const p of pts) bb.extend(p);
            map.fitBounds(bb, { padding: 80, duration: 0 });

            // Endpoints must be water (we’ll nudge a hair offshore if needed)
            const A = { lng: pts[0][0], lat: pts[0][1] };
            const Z = { lng: pts[pts.length - 1][0], lat: pts[pts.length - 1][1] };
            if (isLand(A) || isLand(Z)) {
                // try a small nudge before bailing
                const A2 = nudgeOffshore(A, { h3, h3Res: H3_RES, hasLandCell, dilateKRings: DILATE_K });
                const Z2 = nudgeOffshore(Z, { h3, h3Res: H3_RES, hasLandCell, dilateKRings: DILATE_K });
                if (isLand(A2) || isLand(Z2)) {
                    return alert('Move the start/end points slightly off the coast (they must be in water).');
                }
                // replace original points with nudged copies
                pts[0] = [A2.lng, A2.lat];
                pts[pts.length - 1] = [Z2.lng, Z2.lat];
            }

            setStatus('Routing on water (hex A*)…');

            const route = await autoroute(map, pts, {
                h3, h3Res: H3_RES,
                hasLandCell,
                dilateKRings: DILATE_K,
                padDeg: 3.0,
                sampleMeters: 500,
                corridorStepDeg: 0.08
            });

            const coords = route?.geometry?.coordinates || [];
            if (coords.length < 2) {
                setStatus('No water-only route found with current settings.');
                return alert('No water-only route found with current settings.');
            }

            const next = { ...fc, features: [...fc.features, route] };
            api.setFeatureCollection(next);
            render(next);

            try {
                const km = (await import('https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/+esm'))
                    .length(route, { units: 'kilometers' });
                setStatus(`Route length: ${km.toFixed(1)} km`);
            } catch {
                setStatus('Route ready.');
            }
        } catch (err) {
            console.error('Autoroute failed:', err);
            setStatus('Autoroute failed.');
            alert(`Autoroute failed: ${err.message || err}`);
        }
    });
});
