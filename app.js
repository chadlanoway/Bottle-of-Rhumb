// http://184.72.204.18:8000/
//pk.eyJ1IjoiNTlub3J0aGx0ZCIsImEiOiJjbWFvbWJ3cWkwOHYyMmxwdng0a3U3Y3hwIn0.foCCShBlTgCQ1rzTL85KFg
// app.js (frontend)
import { initDrawingTools } from './drawing-tools.js';
import { autoroute } from './autoroute.js';
//import * as mapboxPmTiles from 'https://cdn.jsdelivr.net/npm/mapbox-pmtiles@1.0.54/dist/mapbox-pmtiles.js'; 
mapboxgl.accessToken = 'pk.eyJ1IjoiNTlub3J0aGx0ZCIsImEiOiJjbWFvbWJ3cWkwOHYyMmxwdng0a3U3Y3hwIn0.foCCShBlTgCQ1rzTL85KFg';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: [-40, 30],
    zoom: 2
});

map.on('load', async () => {
    const api = initDrawingTools(map);

    mapboxgl.Style.setSourceType(
        mapboxPmTiles.SOURCE_TYPE,
        mapboxPmTiles.PmTilesSource
    );

    map.addSource('land-src', {
        type: mapboxPmTiles.SOURCE_TYPE,
        url: 'https://dgme6gz9k7dme.cloudfront.net/land.pmtiles'
    });

    await new Promise(res => {
        const onData = e => {
            if (e.sourceId === 'land-src' && e.isSourceLoaded) {
                map.off('sourcedata', onData);
                res();
            }
        };
        map.on('sourcedata', onData);
    });

    if (!map.getLayer('land-mask-fill')) {
        const SOURCE_LAYER = 'land';
        map.addLayer({
            id: 'land-mask-fill',
            type: 'fill',
            source: 'land-src',
            'source-layer': SOURCE_LAYER,
            paint: { 'fill-color': '#000', 'fill-opacity': 0.03 }
        }, 'waterway-label');
    }

    console.log('✅ land-mask-fill added using source-layer="land"');

    // Right-panel JSON 
    const wrap = document.getElementById('jsonWrap');
    const tab = document.getElementById('jsonTab');
    const txt = document.getElementById('jsonText');
    const btnCopy = document.getElementById('btnCopyJson');
    const btnDl = document.getElementById('btnDownloadJson');

    function render(fc = api.getFeatureCollection()) {
        if (txt) txt.value = JSON.stringify(fc, null, 2);
    }
    window.addEventListener('draw:change', (e) => render(e.detail.fc));

    if (tab && wrap) {
        tab.addEventListener('click', () => {
            wrap.classList.toggle('open');
            tab.setAttribute('aria-expanded', wrap.classList.contains('open'));
            if (wrap.classList.contains('open')) render();
        });
    }
    if (btnCopy && txt) {
        btnCopy.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(txt.value); btnCopy.textContent = 'Copied!'; setTimeout(() => btnCopy.textContent = 'Copy', 900); }
            catch { alert('Copy failed'); }
        });
    }
    if (btnDl && txt) {
        btnDl.addEventListener('click', () => {
            const blob = new Blob([txt.value], { type: 'application/geo+json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'drawing.geojson';
            a.click();
            URL.revokeObjectURL(a.href);
        });
    }
    render();

    // Autoroute button
    document.getElementById('btnAutoroute')?.addEventListener('click', async () => {
        try {
            const fc = api.getFeatureCollection();
            const pts = fc.features
                .filter(f => f.geometry?.type === 'Point')
                .map(f => f.geometry.coordinates);

            if (pts.length < 2) return alert('Add at least two Points, then click Autoroute.');

            // keep the segment in view so the land tiles are definitely loaded
            const bb = new mapboxgl.LngLatBounds(pts[0], pts[0]);
            for (const p of pts) bb.extend(p);
            map.fitBounds(bb, { padding: 80, duration: 0 });

            console.time('autoroute');
            const route = await autoroute(map, pts, {
                landLayerId: 'land-mask-fill',
                padPx: 3,
                sampleMeters: 900,
                stepMetersNear: 5000,
                stepMetersFar: 40000,
                coastNearMeters: 25000,
                maxSteps: 24000,
                detour: {
                    startKm: 4,
                    endKm: 800,
                    grow: 1.5,
                    angStep: 8
                }
            });
            console.timeEnd('autoroute');

            const coords = route?.geometry?.coordinates || [];
            if (coords.length < 2) {
                console.warn('autoroute returned too few coords', route);
                return alert('No water-only path found with current settings.');
            }

            const next = { ...fc, features: [...fc.features, route] };
            api.setFeatureCollection(next);
            render(next);
        } catch (err) {
            console.error('Autoroute failed:', err);
            alert(`Autoroute failed: ${err.message || err}`);
        }
    });
});
