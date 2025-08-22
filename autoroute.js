// autoroute.js — HEX-GRID (H3) A* ROUTER with connectivity-safe corridor + fallbacks
// needs tightening to speed things up but it's working
const R = 6371008.8;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

function haversineM(a, b) {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const h = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function destM(a, distM, brgDeg) {
    const δ = distM / R, θ = toRad(brgDeg);
    const φ1 = toRad(a.lat), λ1 = toRad(a.lng);
    const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
    const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
    const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
    const x = Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2);
    const λ2 = λ1 + Math.atan2(y, x);
    return { lng: ((toDeg(λ2) + 540) % 360) - 180, lat: toDeg(φ2) };
}

// ── Land checks (Bloom-backed, dilated K rings) ───────────────────────────────
function makeIsCellBlocked({ h3, hasLandCell, dilateKRings = 1 }) {
    const memo = new Map();
    return function isCellBlocked(cell) {
        if (memo.has(cell)) return memo.get(cell);
        if (hasLandCell(cell)) { memo.set(cell, true); return true; }
        if (dilateKRings > 0) {
            for (const nb of h3.kRing(cell, dilateKRings)) {
                if (hasLandCell(nb)) { memo.set(cell, true); return true; }
            }
        }
        memo.set(cell, false);
        return false;
    };
}

// Sample a->b every ~sampleMeters; reject if any sampled H3 cell is (dilated) land
function chordCrossesLand(a, b, { h3, h3Res, isCellBlocked, sampleMeters = 500 }) {
    const dist = haversineM(a, b);
    const n = Math.max(1, Math.ceil(dist / sampleMeters));
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        const p = { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t };
        const cell = h3.geoToH3(p.lat, p.lng, h3Res);
        if (isCellBlocked(cell)) return true;
    }
    return false;
}

// ── Corridor of candidate cells ───────────────────────────────────────────────
// Base corridor is a padded bbox sampled in lon/lat; we then ensure connectivity
function corridorCells(A, B, { h3, h3Res, isCellBlocked, padDeg = 3.0, corridorStepDeg = 0.08 }) {
    const west = Math.min(A.lng, B.lng) - padDeg;
    const east = Math.max(A.lng, B.lng) + padDeg;
    const south = Math.min(A.lat, B.lat) - padDeg;
    const north = Math.max(A.lat, B.lat) + padDeg;

    const cells = new Set();
    for (let lat = south; lat <= north; lat += corridorStepDeg) {
        const stepLon = corridorStepDeg / Math.max(0.2, Math.cos(toRad(lat)));
        for (let lng = west; lng <= east; lng += stepLon) {
            const cell = h3.geoToH3(lat, lng, h3Res);
            if (!isCellBlocked(cell)) cells.add(cell);
        }
    }
    return cells;
}

function expandSetKRings(h3, base, k = 1) {
    if (!base) return null;
    const out = new Set(base);
    for (const c of base) for (const n of h3.kRing(c, k)) out.add(n);
    return out;
}

// Nearest water cell to point
function nearestWaterCell(p, { h3, h3Res, isCellBlocked, maxRings = 60 }) {
    const seed = h3.geoToH3(p.lat, p.lng, h3Res);
    if (!isCellBlocked(seed)) return seed;
    for (let r = 1; r <= maxRings; r++) {
        for (const c of h3.kRing(seed, r)) {
            if (!isCellBlocked(c)) return c;
        }
    }
    return null;
}

function h3Center(cell, h3) {
    const [lat, lng] = h3.h3ToGeo(cell);
    return { lng, lat };
}

// ── A* on H3 ─────────────────────────────────────────────────────────────────
function aStarH3(startCell, goalCell, { h3, h3Res, isCellBlocked, allowed = null }) {
    if (startCell === goalCell) return [startCell];

    const open = new Map();  // cell -> f
    const g = new Map();     // cell -> g
    const came = new Map();  // cell -> parent

    const goalC = h3Center(goalCell, h3);

    function popMin() {
        let best = null, bestF = Infinity;
        for (const [c, f] of open) if (f < bestF) { bestF = f; best = c; }
        if (best) open.delete(best);
        return best;
    }

    const startC = h3Center(startCell, h3);
    g.set(startCell, 0);
    open.set(startCell, haversineM(startC, goalC));

    let guard = 0;
    while (open.size) {
        if (++guard > 200000) break; // hard safety stop
        const cur = popMin();
        if (!cur) break;
        if (cur === goalCell) {
            const path = [cur];
            for (let k = cur; came.has(k);) { k = came.get(k); path.push(k); }
            return path.reverse();
        }

        for (const nb of h3.kRing(cur, 1)) {
            if (nb === cur) continue;
            if (allowed && !allowed.has(nb)) continue;
            if (isCellBlocked(nb)) continue;

            const curC = h3Center(cur, h3);
            const nbC = h3Center(nb, h3);
            if (chordCrossesLand(curC, nbC, { h3, h3Res, isCellBlocked, sampleMeters: 300 })) continue;

            const tentative = (g.get(cur) ?? Infinity) + haversineM(curC, nbC);
            if (tentative < (g.get(nb) ?? Infinity)) {
                g.set(nb, tentative);
                came.set(nb, cur);
                open.set(nb, tentative + haversineM(nbC, goalC));
            }
        }
    }
    return null;
}

// ── Smoothing ────────────────────────────────────────────────────────────────
function smoothCenters(centers, losOpts) {
    if (centers.length <= 2) return centers;
    const out = [centers[0]];
    let anchor = 0;
    for (let i = 2; i < centers.length; i++) {
        const A = centers[anchor];
        const C = centers[i];
        if (chordCrossesLand(A, C, losOpts)) {
            out.push(centers[i - 1]);
            anchor = i - 1;
        }
    }
    out.push(centers[centers.length - 1]);
    return out;
}

// ── Public API ───────────────────────────────────────────────────────────────
export function nudgeOffshore(p, opts) {
    const {
        h3, h3Res, hasLandCell,
        maxNudgeMeters = 5000, nudgeStepMeters = 200, dilateKRings = 1
    } = opts;

    const isCellBlocked = makeIsCellBlocked({ h3, hasLandCell, dilateKRings });
    const startCell = h3.geoToH3(p.lat, p.lng, h3Res);
    if (!isCellBlocked(startCell)) return p;

    for (let d = nudgeStepMeters; d <= maxNudgeMeters; d += nudgeStepMeters) {
        for (let br = 0; br < 360; br += 15) {
            const q = destM(p, d, br);
            const cell = h3.geoToH3(q.lat, q.lng, h3Res);
            if (!isCellBlocked(cell)) return q;
        }
    }
    return p;
}

export async function autoroute(map, waypoints, opts) {
    const {
        h3, h3Res, hasLandCell,
        dilateKRings = 1, padDeg = 3.0, sampleMeters = 500, corridorStepDeg = 0.08
    } = opts;

    if (!h3 || typeof h3.geoToH3 !== 'function') throw new Error('autoroute: missing h3');
    if (typeof hasLandCell !== 'function') throw new Error('autoroute: opts.hasLandCell(h) required');

    const isCellBlocked = makeIsCellBlocked({ h3, hasLandCell, dilateKRings });
    const routeCoords = [];

    for (let i = 0; i < waypoints.length - 1; i++) {
        let A = { lng: waypoints[i][0], lat: waypoints[i][1] };
        let B = { lng: waypoints[i + 1][0], lat: waypoints[i + 1][1] };

        // nudge endpoints slightly offshore if needed
        A = nudgeOffshore(A, { h3, h3Res, hasLandCell, dilateKRings });
        B = nudgeOffshore(B, { h3, h3Res, hasLandCell, dilateKRings });

        // Direct chord fast-path
        if (!chordCrossesLand(A, B, { h3, h3Res, isCellBlocked, sampleMeters })) {
            if (routeCoords.length === 0) routeCoords.push([A.lng, A.lat]);
            routeCoords.push([B.lng, B.lat]);
            continue;
        }

        // Build corridor and ensure connectivity; then try progressively wider searches.
        const baseAllowed = corridorCells(A, B, { h3, h3Res, isCellBlocked, padDeg, corridorStepDeg });
        const allowed1 = expandSetKRings(h3, baseAllowed, 1);     // connect sparse samples
        const allowed2 = expandSetKRings(h3, baseAllowed, 2);     // wider
        const allowed3 = corridorCells(A, B, { h3, h3Res, isCellBlocked, padDeg: padDeg * 2, corridorStepDeg: corridorStepDeg * 0.8 });

        const start = nearestWaterCell(A, { h3, h3Res, isCellBlocked, maxRings: 60 });
        const goal = nearestWaterCell(B, { h3, h3Res, isCellBlocked, maxRings: 60 });
        if (!start || !goal) throw new Error('No water node near start/end');

        let cells =
            aStarH3(start, goal, { h3, h3Res, isCellBlocked, allowed: allowed1 }) ||
            aStarH3(start, goal, { h3, h3Res, isCellBlocked, allowed: allowed2 }) ||
            aStarH3(start, goal, { h3, h3Res, isCellBlocked, allowed: allowed3 }) ||
            aStarH3(start, goal, { h3, h3Res, isCellBlocked, allowed: null }); // ultimate fallback

        if (!cells || cells.length < 2) throw new Error('No water path found');

        const centers = cells.map(c => h3Center(c, h3));
        const smooth = smoothCenters(centers, { h3, h3Res, isCellBlocked, sampleMeters });

        if (routeCoords.length === 0) routeCoords.push([smooth[0].lng, smooth[0].lat]);
        for (let j = 1; j < smooth.length; j++) {
            routeCoords.push([smooth[j].lng, smooth[j].lat]);
        }
    }

    return {
        type: 'Feature',
        properties: { kind: 'autoroute' },
        geometry: { type: 'LineString', coordinates: routeCoords }
    };
}
