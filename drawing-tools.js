// drawing-tools.js
// Sets up drawing tools on the given map (point, line, polygon, clear).
export function initDrawingTools(map) {
    const toolsStatus = document.getElementById('toolsStatus');
    const wrap = document.getElementById('toolsWrap');
    const toolsTab = document.getElementById('toolsTab');

    // Toggle the tools panel when clicking the tab
    toolsTab?.addEventListener('click', () => {
        wrap.classList.toggle('open');
        toolsTab.setAttribute('aria-expanded', wrap.classList.contains('open'));
    });

    // Current drawing state
    let mode = null;                    // current mode: 'point', 'line', 'poly', or null
    let temp = [];                      // fixed vertices for the feature being drawn
    let fc = { type: 'FeatureCollection', features: [] }; // saved features
    let vertsFC = { type: 'FeatureCollection', features: [] }; // all vertices

    const FINISH_TOL_PX = 10;           // click distance (px) to finish shape

    // Tooltip for showing info while drawing
    let tooltipEl = null;
    function ensureTooltip() {
        if (tooltipEl) return tooltipEl;
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'draw-tooltip';
        Object.assign(tooltipEl.style, {
            position: 'absolute',
            pointerEvents: 'none',
            padding: '2px 6px',
            background: 'rgba(0,0,0,0.75)',
            color: '#fff',
            font: '12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
            borderRadius: '4px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            transform: 'translate(12px, -12px)',
            zIndex: 2,
            display: 'none'
        });
        map.getContainer().appendChild(tooltipEl);
        return tooltipEl;
    }
    function showTooltip(text, point) {
        ensureTooltip();
        tooltipEl.textContent = text;
        tooltipEl.style.left = point.x + 'px';
        tooltipEl.style.top = point.y + 'px';
        tooltipEl.style.display = 'block';
    }
    function hideTooltip() {
        if (tooltipEl) tooltipEl.style.display = 'none';
    }

    // --- distance utilities (for line length in NM) ---
    const R_EARTH_M = 6371008.8;
    const toRad = d => d * Math.PI / 180;
    function haversineMeters(a, b) {
        const dLat = toRad(b[1] - a[1]);
        const dLon = toRad(b[0] - a[0]);
        const lat1 = toRad(a[1]);
        const lat2 = toRad(b[1]);
        const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
        const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
        return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    function pathMeters(coords) {
        let m = 0;
        for (let i = 1; i < coords.length; i++) m += haversineMeters(coords[i - 1], coords[i]);
        return m;
    }
    function metersToNM(m) { return m / 1852; }
    function formatNM(nm) {
        if (nm < 10) return nm.toFixed(2) + ' nm';
        if (nm < 100) return nm.toFixed(1) + ' nm';
        return Math.round(nm) + ' nm';
    }

    // Add a layer to the map only if it does not already exist
    function addLayerOnce(spec) { if (!map.getLayer(spec.id)) map.addLayer(spec); }

    // Turns a feature into its point vertices
    function vertsFromFeature(feat) {
        const f = feat && feat.geometry ? feat : null;
        if (!f) return [];
        const type = f.geometry.type;
        const coords = f.geometry.coordinates;
        const mk = (c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } });

        if (type === 'Point') return [mk(coords)];
        if (type === 'LineString') return coords.map(mk);
        if (type === 'Polygon') return (coords[0] || []).map(mk); // outer ring
        if (type === 'MultiLineString') return coords.flat().map(mk);
        if (type === 'MultiPolygon') return coords.flat(1).flat().map(mk); // outer rings
        return [];
    }

    // Rebuilds the vertices collection from all saved features
    function rebuildVerts() {
        const all = fc.features.flatMap(vertsFromFeature);
        vertsFC = { type: 'FeatureCollection', features: all };
        const src = map.getSource('draw-verts');
        if (src) src.setData(vertsFC);
    }

    // Show temp vertices while drawing
    function updateTempVerts(fixedCoords) {
        const fcPts = {
            type: 'FeatureCollection',
            features: fixedCoords.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c } }))
        };
        if (!map.getSource('temp-verts')) {
            map.addSource('temp-verts', { type: 'geojson', data: fcPts });
            addLayerOnce({
                id: 'temp-verts',
                type: 'circle',
                source: 'temp-verts',
                paint: {
                    'circle-radius': 4,
                    'circle-color': '#1e90ff',
                    'circle-stroke-width': 1,
                    'circle-stroke-color': '#fff'
                }
            });
        } else {
            map.getSource('temp-verts').setData(fcPts);
        }
    }

    // Highlight the most recently placed vertex
    function highlightLast(coord) {
        if (!coord) return;
        const pt = { type: 'Feature', geometry: { type: 'Point', coordinates: coord } };
        if (!map.getSource('temp-last')) {
            map.addSource('temp-last', { type: 'geojson', data: pt });
            addLayerOnce({
                id: 'temp-last',
                type: 'circle',
                source: 'temp-last',
                paint: {
                    'circle-radius': 6,
                    'circle-color': '#fff',
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#1e90ff'
                }
            });
        } else {
            map.getSource('temp-last').setData(pt);
        }
    }

    // Creates the permanent draw layers and sources (runs on load and style change)
    function ensureDrawLayers() {
        if (!map.getSource('draw')) {
            map.addSource('draw', { type: 'geojson', data: fc });
        } else {
            map.getSource('draw').setData(fc);
        }

        addLayerOnce({
            id: 'draw-polys', type: 'fill', source: 'draw',
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': '#1e90ff', 'fill-opacity': 0.25 }
        });

        addLayerOnce({
            id: 'draw-lines', type: 'line', source: 'draw',
            filter: ['==', ['geometry-type'], 'LineString'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#1e90ff', 'line-width': 3 }
        });

        addLayerOnce({
            id: 'draw-points', type: 'circle', source: 'draw',
            filter: ['==', ['geometry-type'], 'Point'],
            paint: { 'circle-radius': 5, 'circle-color': '#08f', 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' }
        });

        // Permanent vertex source (hidden until needed)
        if (!map.getSource('draw-verts')) {
            rebuildVerts();
            map.addSource('draw-verts', { type: 'geojson', data: vertsFC });
        } else {
            map.getSource('draw-verts').setData(vertsFC);
        }
        addLayerOnce({
            id: 'draw-verts', type: 'circle', source: 'draw-verts',
            layout: { visibility: 'none' },
            paint: {
                'circle-radius': 4,
                'circle-color': '#1e90ff',
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#fff',
                'circle-opacity': 0.9,
                'circle-stroke-opacity': 0.9
            }
        });
    }

    if (map.isStyleLoaded()) ensureDrawLayers();
    map.on('load', ensureDrawLayers);
    map.on('styledata', ensureDrawLayers);

    // Replace the feature collection and update everything
    function setFC(next) {
        fc = next;
        const src = map.getSource('draw');
        if (src) src.setData(fc);
        rebuildVerts();
        window.dispatchEvent(new CustomEvent('draw:change', { detail: { fc } }));
    }

    // Add one feature to the collection
    function pushFeature(feat) { setFC({ ...fc, features: [...fc.features, feat] }); }

    // Remove temporary drawing layers and reset temp vertices
    function clearTemp() {
        temp = [];
        ['temp-line', 'temp-poly', 'temp-poly-outline', 'temp-verts', 'temp-last'].forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
            if (map.getSource(id)) map.removeSource(id);
        });
    }

    // Draws the temporary line preview while drawing
    function drawTempLine(fixedCoords, pathCoords) {
        const geo = { type: 'Feature', geometry: { type: 'LineString', coordinates: pathCoords } };
        if (!map.getSource('temp-line')) {
            map.addSource('temp-line', { type: 'geojson', data: geo });
            map.addLayer({
                id: 'temp-line',
                type: 'line',
                source: 'temp-line',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#1e90ff', 'line-width': 2, 'line-dasharray': [2, 2] }
            });
        } else {
            map.getSource('temp-line').setData(geo);
        }
        updateTempVerts(fixedCoords);
        highlightLast(fixedCoords[fixedCoords.length - 1]);
    }

    // Draws the temporary polygon preview while drawing
    function drawTempPoly(fixedCoords, pathCoords) {
        // outline
        if (pathCoords.length >= 2) {
            const line = { type: 'Feature', geometry: { type: 'LineString', coordinates: pathCoords } };
            if (!map.getSource('temp-poly-outline')) {
                map.addSource('temp-poly-outline', { type: 'geojson', data: line });
                map.addLayer({
                    id: 'temp-poly-outline',
                    type: 'line',
                    source: 'temp-poly-outline',
                    layout: { 'line-cap': 'round', 'line-join': 'round' },
                    paint: { 'line-color': '#1e90ff', 'line-width': 2, 'line-dasharray': [2, 2] }
                });
            } else {
                map.getSource('temp-poly-outline').setData(line);
            }
        }

        // fill
        if (pathCoords.length >= 3) {
            const ring = [...pathCoords, pathCoords[0]];
            const poly = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } };
            if (!map.getSource('temp-poly')) {
                map.addSource('temp-poly', { type: 'geojson', data: poly });
                map.addLayer({
                    id: 'temp-poly',
                    type: 'fill',
                    source: 'temp-poly',
                    paint: { 'fill-color': '#1e90ff', 'fill-opacity': 0.20 }
                });
            } else {
                map.getSource('temp-poly').setData(poly);
            }
        } else {
            if (map.getLayer('temp-poly')) map.removeLayer('temp-poly');
            if (map.getSource('temp-poly')) map.removeSource('temp-poly');
        }
        updateTempVerts(fixedCoords);
        highlightLast(fixedCoords[fixedCoords.length - 1]);
    }

    // Finalize a line and save it
    function finishLine() {
        if (temp.length >= 2) {
            pushFeature({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: temp } });
            toolsStatus && (toolsStatus.textContent = 'line added');
        }
        hideTooltip();
        clearTemp();
        map.doubleClickZoom.enable();
        mode = null;
        map.getCanvas().style.cursor = '';
    }

    // Finalize a polygon and save it
    function finishPoly() {
        if (temp.length >= 3) {
            const ring = [...temp, temp[0]];
            pushFeature({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
            toolsStatus && (toolsStatus.textContent = 'polygon added');
        }
        clearTemp();
        map.doubleClickZoom.enable();
        mode = null;
        map.getCanvas().style.cursor = '';
    }

    // Checks if a click is near the last placed vertex
    function isNearLastVertex(e) {
        if (!temp.length) return false;
        const last = temp[temp.length - 1];
        const pLast = map.project({ lng: last[0], lat: last[1] });
        const dx = e.point.x - pLast.x;
        const dy = e.point.y - pLast.y;
        return Math.hypot(dx, dy) <= FINISH_TOL_PX;
    }

    // Toolbar buttons: set mode, reset temp, update status
    document.getElementById('btnPoint')?.addEventListener('click', () => {
        mode = 'point'; temp = [];
        toolsStatus && (toolsStatus.textContent = 'mode: POINT — click map to add a point');
        map.getCanvas().style.cursor = 'crosshair';
        clearTemp();
    });

    document.getElementById('btnLine')?.addEventListener('click', () => {
        mode = 'line'; temp = [];
        toolsStatus && (toolsStatus.textContent = 'mode: LINE — click to add vertices; double-click or re-click last vertex to finish');
        map.doubleClickZoom.disable();
        map.getCanvas().style.cursor = 'crosshair';
        clearTemp();
        ensureTooltip();
        showTooltip('0.00 nm', { x: map.getCanvas().width / 2, y: map.getCanvas().height / 2 });
    });

    document.getElementById('btnPoly')?.addEventListener('click', () => {
        mode = 'poly'; temp = [];
        toolsStatus && (toolsStatus.textContent = 'mode: POLYGON — click to add vertices; double-click or re-click last vertex to finish');
        map.doubleClickZoom.disable();
        map.getCanvas().style.cursor = 'crosshair';
        clearTemp();
    });

    document.getElementById('btnClear')?.addEventListener('click', () => {
        clearTemp();
        setFC({ type: 'FeatureCollection', features: [] });
        toolsStatus && (toolsStatus.textContent = 'cleared');
    });

    // Handle clicks for each mode
    map.on('click', (e) => {
        if (!mode) return;
        const p = [e.lngLat.lng, e.lngLat.lat];

        if (mode === 'point') {
            pushFeature({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } });
            toolsStatus && (toolsStatus.textContent = 'point added');
            mode = null; map.getCanvas().style.cursor = '';
            return;
        }

        if (mode === 'line') {
            if (isNearLastVertex(e) && temp.length >= 2) return finishLine();
            temp.push(p);
            drawTempLine(temp, temp);
            return;
        }

        if (mode === 'poly') {
            if (isNearLastVertex(e) && temp.length >= 3) return finishPoly();
            temp.push(p);
            drawTempPoly(temp, temp);
            return;
        }
    });

    // Handle mouse move for live preview
    map.on('mousemove', (e) => {
        if (!mode) return;
        const cursor = [e.lngLat.lng, e.lngLat.lat];

        if (mode === 'line') {
            if (temp.length >= 1) {
                const path = [...temp, cursor];
                drawTempLine(temp, path);
                const nm = metersToNM(pathMeters(path));
                showTooltip(formatNM(nm), e.point);
            } else {
                showTooltip('0.00 nm', e.point);
            }
        }

        if (mode === 'poly') {
            if (temp.length >= 1) {
                const path = [...temp, cursor];
                drawTempPoly(temp, path);
            }
            hideTooltip();
        }
    });

    // Double-click finishes a line or polygon
    map.on('dblclick', (e) => {
        e.preventDefault();
        if (mode === 'line') return finishLine();
        if (mode === 'poly') return finishPoly();
    });

    // Return helper functions for external use
    return {
        getFeatureCollection: () => fc,
        setFeatureCollection: (next) => setFC(next || { type: 'FeatureCollection', features: [] }),
        showVertices: (show) => {
            if (map.getLayer('draw-verts')) {
                map.setLayoutProperty('draw-verts', 'visibility', show ? 'visible' : 'none');
            }
        }
    };
}
