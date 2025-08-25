// autoroute.js - H3 A* water router + macro skeleton + GC detour fallback
// (noise-tolerant land mask + no-hard-fail seeding; **GC-safe sampling**)

// ----------------------------- helpers -----------------------------
const R = 6371008.8;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

const normLng = lng => ((lng + 540) % 360) - 180;

function haversineM(a, b) {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const h = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
    const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
    const Δλ = toRad(b.lng - a.lng);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function destM(a, meters, brgDeg) {
    const δ = meters / R, θ = toRad(brgDeg);
    const φ1 = toRad(a.lat), λ1 = toRad(a.lng);
    const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
    const sinδ = Math.sin(δ), cosδ = Math.cos(δ);
    const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
    const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
    const y = Math.sin(θ) * sinδ * cosφ1;
    const x = cosδ - sinφ1 * Math.sin(φ2);
    const λ2 = λ1 + Math.atan2(y, x);
    return { lng: ((toDeg(λ2) + 540) % 360) - 180, lat: toDeg(φ2) };
}
const lerp = (A, B, t) => ({ lng: A.lng + (B.lng - A.lng) * t, lat: A.lat + (B.lat - A.lat) * t });

function gcPoints(A, B, n = 128) {
    const φ1 = toRad(A.lat), λ1 = toRad(A.lng);
    const φ2 = toRad(B.lat), λ2 = toRad(B.lng);
    const dφ = φ2 - φ1, dλ = λ2 - λ1;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    const δ = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    if (δ === 0) return [A, B];

    const sinδ = Math.sin(δ);
    const x1 = Math.cos(φ1) * Math.cos(λ1), y1 = Math.cos(φ1) * Math.sin(λ1), z1 = Math.sin(φ1);
    const x2 = Math.cos(φ2) * Math.cos(λ2), y2 = Math.cos(φ2) * Math.sin(λ2), z2 = Math.sin(φ2);

    const pts = new Array(n + 1);
    for (let i = 0; i <= n; i++) {
        const f = i / n;
        const A1 = Math.sin((1 - f) * δ) / sinδ;
        const B1 = Math.sin(f * δ) / sinδ;
        const x = A1 * x1 + B1 * x2;
        const y = A1 * y1 + B1 * y2;
        const z = A1 * z1 + B1 * z2;
        const φ = Math.atan2(z, Math.hypot(x, y));
        const λ = Math.atan2(y, x);
        pts[i] = { lng: ((toDeg(λ) + 540) % 360) - 180, lat: toDeg(φ) };
    }
    return pts;
}

function bearingsFanAround(center, step = 10, widen = 1) {
    const raw = []; for (let b = 0; b < 360; b += step) raw.push(b);
    const norm = x => ((x % 360) + 360) % 360;
    const score = b => { const d = Math.min(Math.abs(norm(b - center)), 360 - Math.abs(norm(b - center))); return d; };
    const sorted = raw.sort((a, b) => score(a) - score(b));
    return widen > 1 ? [...sorted.slice(0, 12), ...sorted] : sorted;
}

// Returns a land check function that ignores isolated noise cells.
// It only treats a cell as land if enough of its immediate neighbors are also land.
function makeHasLandCellNoiseTolerant(h3, hasLandCell, neighborThresh = 3) {
    return (cell) => {
        if (!hasLandCell(cell)) return false;
        let n = 0;
        for (const nb of h3.kRing(cell, 1)) if (hasLandCell(nb)) n++;
        return n >= neighborThresh;
    };
}

// Builds and returns a function that says if a cell is blocked by land.
// Uses a small cache, treats near-shore cells as blocked by dilating K rings.
function makeIsCellBlocked({ h3, h3Res, hasLandCell, dilateKRings = 1 }) {
    const memo = new Map();
    const noiseHasLand = makeHasLandCellNoiseTolerant(h3, hasLandCell, 3);
    return function isCellBlocked(cell) {
        if (memo.has(cell)) return memo.get(cell);
        let blocked = false;
        if (noiseHasLand(cell)) blocked = true;
        else if (dilateKRings > 0) for (const nb of h3.kRing(cell, dilateKRings)) { if (noiseHasLand(nb)) { blocked = true; break; } }
        memo.set(cell, blocked);
        return blocked;
    };
}

// Quick point check: returns true if the given lng,lat falls in a blocked H3 cell.
function pointIsLand(lng, lat, { h3, h3Res, isCellBlocked }) {
    return isCellBlocked(h3.geoToH3(lat, lng, h3Res));
}

// Checks if the great circle chord between A and B crosses land.
// Samples along the path every sampleMeters (min samples enforced) and returns true on first land hit.
function chordCrossesLand(A, B, { h3, h3Res, isCellBlocked, sampleMeters = 250 }) {
    const d = haversineM(A, B);
    const n = Math.max(48, Math.ceil(d / sampleMeters));
    const pts = gcPoints(A, B, n);
    for (let i = 1; i < pts.length; i++) if (pointIsLand(pts[i].lng, pts[i].lat, { h3, h3Res, isCellBlocked })) return true;
    return false;
}

// --------------------- GC detour fallback -----------------------

// Walks along the segment from A to B and returns the first sampled point that is on land.
// Returns null if no hit.
function firstHitOnSegment(A, B, ctx) {
    const d = haversineM(A, B);
    const n = Math.max(256, Math.ceil(d / Math.max(250, ctx.sampleMeters ?? 400)));
    const pts = gcPoints(A, B, n);
    for (let i = 0; i < pts.length; i++) if (pointIsLand(pts[i].lng, pts[i].lat, ctx)) return pts[i];
    return null;
}

// Tries a single detour using one temporary waypoint C.
// C is searched around a perpendicular fan at several radii until a water-only path A-C-B is found.
function trySingleDetour(A, B, ctx) {
    const hit = firstHitOnSegment(A, B, ctx) || lerp(A, B, 0.5);
    const brgAB = bearing(A, B);
    const perp = (brgAB + 90) % 360;
    const bearings = bearingsFanAround(perp, ctx.bearingStep ?? 10, 2);
    const radiiKm = ctx.radiiKm ?? [150, 300, 600, 900, 1200, 1600, 2000];

    for (const rKm of radiiKm) {
        for (const brg of bearings) {
            const C = destM(hit, rKm * 1000, brg);
            // Skip if C is on land or if either leg crosses land
            if (pointIsLand(C.lng, C.lat, ctx)) continue;
            if (chordCrossesLand(A, C, ctx)) continue;
            if (chordCrossesLand(C, B, ctx)) continue;
            return [A, C, B];
        }
    }
    return null;
}

// Recursively finds a water-only polyline between A and B.
// If A-B crosses land, try one detour. If that fails, split at midpoint and recurse.
// Stops at maxDepth. Returns an array of points or null.
function landAwareFallback(A, B, ctx, depth = 0, maxDepth = 8) {
    if (depth > maxDepth) return null;
    if (!chordCrossesLand(A, B, ctx)) return [A, B];
    const detour = trySingleDetour(A, B, ctx);
    if (detour) return detour;
    const mid = lerp(A, B, 0.5);
    const L = landAwareFallback(A, mid, ctx, depth + 1, maxDepth);
    const R = landAwareFallback(mid, B, ctx, depth + 1, maxDepth);
    if (!L || !R) return null;
    return [...L.slice(0, -1), ...R];
}

// ------------- corridor / A* / macro (GC corridor) -------------

// Returns the lng,lat center of an H3 cell.
function h3Center(cell, h3) { const [lat, lng] = h3.h3ToGeo(cell); return { lng, lat }; }

// Builds a corridor set of allowed H3 cells between A and B.
// Starts with GC samples, removes land, then dilates by k to pad the corridor.
function corridorCells(A, B, { h3, h3Res, isCellBlocked, padDeg = 3.0, corridorStepDeg = 0.08 }) {
    const steps = Math.max(10, Math.ceil(180 / Math.max(0.5, corridorStepDeg)));
    const pts = gcPoints(A, B, steps);
    const base = new Set();
    for (const p of pts) { const c = h3.geoToH3(p.lat, p.lng, h3Res); if (!isCellBlocked(c)) base.add(c); }
    const k = Math.max(1, Math.round(padDeg / 0.6));
    const out = new Set(base);
    for (const c of base) for (const n of h3.kRing(c, k)) if (!isCellBlocked(n)) out.add(n);
    return out;
}

// Expands a set of cells by k rings. Returns a new set.
function expandSetKRings(h3, base, k = 1) { if (!base) return null; const out = new Set(base); for (const c of base) for (const n of h3.kRing(c, k)) out.add(n); return out; }

// Finds the nearest water cell to point p at the given res. Returns null if none found in maxRings.
function nearestWaterCellAtRes(p, res, { h3, isCellBlocked, maxRings = 400 }) {
    const seed = h3.geoToH3(p.lat, p.lng, res);
    if (!isCellBlocked(seed)) return seed;
    for (let r = 1; r <= maxRings; r++) for (const c of h3.kRing(seed, r)) if (!isCellBlocked(c)) return c;
    return null;
}

// Same as above but uses the main h3Res from the context.
function nearestWaterCell(p, { h3, h3Res, isCellBlocked, maxRings = 300 }) {
    return nearestWaterCellAtRes(p, h3Res, { h3, isCellBlocked, maxRings });
}

// A* on H3 cells from startCell to goalCell.
// Respects an optional allowed set (corridor). Skips land and segments that cross land.
function aStarH3(startCell, goalCell, { h3, h3Res, isCellBlocked, allowed = null, maxExpansions = 200000 }) {
    if (startCell === goalCell) return [startCell];
    const center = (c) => { const [lat, lng] = h3.h3ToGeo(c); return { lng, lat }; };
    const goalC = center(goalCell);
    const g = new Map(), came = new Map(); const heap = [];

    // Min-heap helpers
    const push = (f, c) => { heap.push([f, c]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break;[heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { if (!heap.length) return null; const t = heap[0]; const v = heap.pop(); if (heap.length) { heap[0] = v; let i = 0; for (; ;) { let l = i * 2 + 1, r = l + 1, s = i; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === i) break;[heap[i], heap[s]] = [heap[s], heap[i]]; i = s; } } return t; };

    const f0 = c => haversineM(center(c), goalC);
    g.set(startCell, 0); push(f0(startCell), startCell);

    let guard = 0;
    while (heap.length) {
        if (++guard > maxExpansions) break;
        const popped = pop(); if (!popped) break;
        const [, cur] = popped;

        // Goal reached, reconstruct path
        if (cur === goalCell) { const path = [cur]; for (let k = cur; came.has(k);) { k = came.get(k); path.push(k); } return path.reverse(); }

        // Explore neighbors
        for (const nb of h3.kRing(cur, 1)) {
            if (nb === cur) continue;
            if (allowed && !allowed.has(nb)) continue;
            if (isCellBlocked(nb)) continue;

            // Extra safety: make sure the straight segment between centers does not touch land
            const cC = center(cur), nC = center(nb);
            if (chordCrossesLand(cC, nC, { h3, h3Res, isCellBlocked, sampleMeters: 220 })) continue;

            const tentative = (g.get(cur) ?? Infinity) + haversineM(cC, nC);
            if (tentative < (g.get(nb) ?? Infinity)) { g.set(nb, tentative); came.set(nb, cur); push(tentative + haversineM(nC, goalC), nb); }
        }
    }
    return null;
}

// Drops unnecessary bend points while keeping line of sight off land.
// Keeps the shape simple but safe.
function smoothCenters(centers, losOpts) {
    if (centers.length <= 2) return centers;
    const out = [centers[0]]; let anchor = 0;
    for (let i = 2; i < centers.length; i++) { const A = centers[anchor], C = centers[i]; if (chordCrossesLand(A, C, losOpts)) { out.push(centers[i - 1]); anchor = i - 1; } }
    out.push(centers[centers.length - 1]); return out;
}

// Snaps a click near shore to the nearest safe water point and returns the adjusted point.
// Also returns a short dock leg so the route starts a little off the shore.
export function snapEndpointToWater(p, opts) {
    const { h3, h3Res, hasLandCell, dilateKRings = 1, searchMaxRings = 120, safetyMeters = 150, hintBearing = null } = opts;
    const isCellBlockedCoarse = makeIsCellBlocked({ h3, h3Res, hasLandCell, dilateKRings });
    const seed = h3.geoToH3(p.lat, p.lng, h3Res);
    if (!isCellBlockedCoarse(seed)) return { point: p, dockLeg: null, debug: {} };

    // Try heading out along a bearing first if we have a hint
    const firstGoodAlong = (bearingDeg) => {
        const step = 150, max = 6000;
        for (let d = step; d <= max; d += step) {
            const q = destM(p, d, bearingDeg);
            if (!isCellBlockedCoarse(h3.geoToH3(q.lat, q.lng, h3Res))) return q;
        }
        return null;
    };
    let C = Number.isFinite(hintBearing) ? firstGoodAlong(hintBearing) : null;

    // Otherwise spiral search outward by rings
    if (!C) {
        let targetCell = null;
        for (let r = 1; r <= searchMaxRings && !targetCell; r++) {
            for (const c of h3.kRing(seed, r)) { if (!isCellBlockedCoarse(c)) { targetCell = c; break; } }
        }
        if (!targetCell) return { point: p, dockLeg: null, debug: { dock: { type: 'no-water' } } };
        const [tLat, tLng] = h3.h3ToGeo(targetCell);
        C = { lng: tLng, lat: tLat };
    }

    // Walk toward C and find the first water point
    const steps = 20; let firstWaterT = null;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps; const q = lerp(p, C, t);
        if (!isCellBlockedCoarse(h3.geoToH3(q.lat, q.lng, h3Res))) { firstWaterT = t; break; }
    }
    if (firstWaterT === null) return { point: C, dockLeg: [[p.lng, p.lat], [C.lng, C.lat]], debug: { dock: { type: 'straight-center' } } };

    // Binary search to get very close to the shoreline, then step out by safetyMeters
    let lo = Math.max(0, firstWaterT - 1 / steps), hi = firstWaterT;
    for (let iter = 0; iter < 24; iter++) {
        const mid = (lo + hi) / 2, q = lerp(p, C, mid);
        const blk = isCellBlockedCoarse(h3.geoToH3(q.lat, q.lng, h3Res));
        if (blk) lo = mid; else hi = mid;
        if (haversineM(lerp(p, C, lo), lerp(p, C, hi)) < 60) break;
    }
    const q = lerp(p, C, hi);
    const Q = destM(q, safetyMeters, bearing(p, C));

    const straight = [[p.lng, p.lat], [Q.lng, Q.lat]];
    return { point: Q, dockLeg: straight, debug: { dock: { type: 'straight' } } };
}

// Returns the lng,lat of the H3 cell center.
function h3CenterPt(c, h3) { const [lat, lng] = h3.h3ToGeo(c); return { lng, lat }; }

// Finds a coarse path at low H3 resolution using a greedy beam search.
// Goal: get a rough water-only skeleton fast, then refine later.
// - isBlocked uses low-res land with small dilation
// - start and goal snap to nearest water cells
// - frontier keeps only the best few candidates (beamWidth)
// - prefers forward motion to the goal and avoids land crossings
function macroGreedySkeleton(A, B, { h3, hasLandCell, dilateKRings, h3ResMacro = 3, beamWidth = 6, maxSteps = 35000, nearGoalRings = 6 }) {
    const isBlocked = makeIsCellBlocked({ h3, h3Res: h3ResMacro, hasLandCell, dilateKRings: Math.max(0, dilateKRings - 1) });
    const start = nearestWaterCellAtRes(A, h3ResMacro, { h3, isCellBlocked: isBlocked, maxRings: 400 });
    const goal = nearestWaterCellAtRes(B, h3ResMacro, { h3, isCellBlocked: isBlocked, maxRings: 400 });
    if (!start || !goal) return null;

    const center = c => h3CenterPt(c, h3), gC = center(goal);
    const brg = (P, Q) => bearing(P, Q), angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

    // frontier holds current best candidates; came tracks backpointers; visited avoids repeats
    let frontier = [{ cell: start, prev: null, score: 0, lastBearing: brg(center(start), gC) }];
    const came = new Map([[start, null]]), visited = new Set([start]);

    for (let step = 0; step < maxSteps; step++) {
        const next = [];

        // expand each candidate by one ring of neighbors
        for (const cand of frontier) {
            // quick goal check: if a straight H3 line is short, we consider it near enough to finish
            let near = []; try { near = h3.line(cand.cell, goal); } catch { near = []; }
            if (near.length && near.length <= nearGoalRings) {
                // rebuild path and return centers
                let path = [goal], cur = cand.cell; while (cur) { path.push(cur); cur = came.get(cur) || null; } path.reverse();
                return path.map(center);
            }

            for (const nb of h3.kRing(cand.cell, 1)) {
                if (nb === cand.cell || visited.has(nb)) continue;
                if (isBlocked(nb)) continue;

                // score neighbors by distance to goal, land crossing penalty, and turn angle penalty
                const cC = center(cand.cell), nC = center(nb);
                const crosses = chordCrossesLand(cC, nC, { h3, h3Res: h3ResMacro, isCellBlocked: isBlocked, sampleMeters: 1500 });
                const landPenalty = crosses ? 120000 : 0;
                const dGoal = haversineM(nC, gC);
                const turnPenalty = angDiff(cand.lastBearing, brg(cC, nC)) * 180;
                const score = dGoal + landPenalty + turnPenalty;
                next.push({ cell: nb, prev: cand.cell, score, lastBearing: brg(cC, nC) });
            }
        }

        // keep only the top beamWidth candidates and mark them visited
        if (!next.length) break;
        next.sort((a, b) => a.score - b.score);
        frontier = next.slice(0, beamWidth);
        for (const x of frontier) { if (!came.has(x.cell)) came.set(x.cell, x.prev); visited.add(x.cell); }
    }
    return null;
}

// Refines one macro leg A to B at the main resolution.
// Steps:
// 1) snap A and B to nearest water cells
// 2) build a GC corridor of allowed cells
// 3) run A* inside the corridor, then with a small expansion, then unconstrained
// 4) smooth the center points and return as coords
function refineLeg(A, B, { h3, h3Res, hasLandCell, dilateKRings, padDeg, corridorStepDeg, sampleMeters }) {
    const isBlocked = makeIsCellBlocked({ h3, h3Res, hasLandCell, dilateKRings: dilateKRings + 1 });
    const start = nearestWaterCell(A, { h3, h3Res, isCellBlocked: isBlocked, maxRings: 200 });
    const goal = nearestWaterCell(B, { h3, h3Res, isCellBlocked: isBlocked, maxRings: 200 });
    if (!start || !goal) return null;

    const allowed = corridorCells(A, B, { h3, h3Res, isCellBlocked: isBlocked, padDeg: padDeg * 1.4, corridorStepDeg });
    const cells =
        aStarH3(start, goal, { h3, h3Res, isCellBlocked: isBlocked, allowed, maxExpansions: 350000 }) ||
        aStarH3(start, goal, { h3, h3Res, isCellBlocked: isBlocked, allowed: expandSetKRings(h3, allowed, 1), maxExpansions: 400000 }) ||
        aStarH3(start, goal, { h3, h3Res, isCellBlocked: isBlocked, allowed: null, maxExpansions: 500000 });

    if (!cells || cells.length < 2) return null;
    const centers = cells.map(c => h3CenterPt(c, h3));
    const smooth = smoothCenters(centers, { h3, h3Res, isCellBlocked: isBlocked, sampleMeters });
    return smooth.map(pt => [pt.lng, pt.lat]);
}

// Main API: builds a water-only route through all waypoints.
// For each leg:
// - snap endpoints slightly offshore
// - try straight great circle if it stays on water
// - else try fine A* with corridor
// - else try macro greedy skeleton then refine each piece
// - else fall back to recursive detours
// The result is a LineString GeoJSON.
export async function autoroute(_map, waypoints, opts) {
    const { h3, h3Res, hasLandCell, dilateKRings = 1, padDeg = 3.0, sampleMeters = 350, corridorStepDeg = 0.08 } = opts;

    if (!h3 || typeof h3.geoToH3 !== 'function') throw new Error('autoroute: missing h3');
    if (typeof hasLandCell !== 'function') throw new Error('autoroute: opts.hasLandCell(h) required');

    const isCellBlocked = makeIsCellBlocked({ h3, h3Res, hasLandCell, dilateKRings });
    const isCellBlockedBuffered = makeIsCellBlocked({ h3, h3Res, hasLandCell, dilateKRings: dilateKRings + 1 });

    const routeCoords = [];

    for (let i = 0; i < waypoints.length - 1; i++) {
        let A = { lng: waypoints[i][0], lat: waypoints[i][1] };
        let B = { lng: waypoints[i + 1][0], lat: waypoints[i + 1][1] };
        const A_CLICK = { ...A };

        // move endpoints off the shore and add short dock legs
        const snapA = snapEndpointToWater(A, { h3, h3Res, hasLandCell, dilateKRings, searchMaxRings: 120, safetyMeters: 150, hintBearing: bearing(A, B) });
        const snapB = snapEndpointToWater(B, { h3, h3Res, hasLandCell, dilateKRings, searchMaxRings: 120, safetyMeters: 150, hintBearing: bearing(B, A) });

        A = snapA.point; B = snapB.point;
        A.lng = normLng(A.lng);
        B.lng = normLng(B.lng);
        console.log('[worker] start:', A, 'end:', B);
        const preDock = snapA.dockLeg, postDock = snapB.dockLeg;

        // simple case: straight GC stays all water, just sample and append
        if (!chordCrossesLand(A, B, { h3, h3Res, isCellBlocked: isCellBlockedBuffered, sampleMeters })) {
            if (routeCoords.length === 0) {
                if (preDock) routeCoords.push(...preDock);
                else routeCoords.push([A_CLICK.lng, A_CLICK.lat]);
            }

            const dMeters = haversineM(A, B);
            const stepKm = 30; // about every 30 km is enough for display
            const n = Math.max(2, Math.ceil(dMeters / (stepKm * 1000)));
            const gc = gcPoints(A, B, n);

            const last = routeCoords[routeCoords.length - 1];
            for (let i = 0; i < gc.length; i++) {
                const p = gc[i];
                if (i === 0 && last && Math.abs(last[0] - p.lng) < 1e-9 && Math.abs(last[1] - p.lat) < 1e-9) continue;
                routeCoords.push([p.lng, p.lat]);
            }

            if (postDock) { routeCoords.push(postDock[1]); routeCoords.push(postDock[0]); }
            continue;
        }

        // fine A* with corridor at main res
        const start = nearestWaterCell(A, { h3, h3Res, isCellBlocked, maxRings: 300 });
        const goal = nearestWaterCell(B, { h3, h3Res, isCellBlocked, maxRings: 300 });

        if (start && goal) {
            const baseAllowed = corridorCells(A, B, { h3, h3Res, isCellBlocked, padDeg, corridorStepDeg });
            console.log('[worker] corridor cells:', baseAllowed.size);
            const allowed1 = expandSetKRings(h3, baseAllowed, 1);
            const allowed2 = expandSetKRings(h3, baseAllowed, 2);

            let cells =
                aStarH3(start, goal, { h3, h3Res, isCellBlocked, allowed: allowed1, maxExpansions: 300000 }) ||
                aStarH3(start, goal, { h3, h3Res, isCellBlocked, allowed: allowed2, maxExpansions: 350000 }) ||
                aStarH3(start, goal, { h3, h3Res, isCellBlocked, allowed: null, maxExpansions: 400000 });
            console.log('[worker] fine path length:', cells ? cells.length : null, cells);
            if (cells && cells.length >= 2) {
                const centers = cells.map(c => h3Center(c, h3));
                const smooth = smoothCenters(centers, { h3, h3Res, isCellBlocked, sampleMeters: Math.max(300, sampleMeters) });

                if (routeCoords.length === 0) { if (preDock) routeCoords.push(...preDock); else routeCoords.push([A_CLICK.lng, A_CLICK.lat]); }
                else routeCoords.push([smooth[0].lng, smooth[0].lat]);
                for (let j = 1; j < smooth.length; j++) routeCoords.push([smooth[j].lng, smooth[j].lat]);
                if (postDock) { routeCoords.push(postDock[1]); routeCoords.push(postDock[0]); }
                else { routeCoords.push([B.lng, B.lat]); }
                continue;
            }
        }

        // coarse macro skeleton, then refine each segment at main res
        const macro = macroGreedySkeleton(A, B, { h3, hasLandCell, dilateKRings, h3ResMacro: Math.max(3, h3Res - 2), beamWidth: 6, maxSteps: 35000, nearGoalRings: 6 });
        console.log('[worker] macro path length:', macro ? macro.length : null, macro);
        if (macro && macro.length >= 2) {
            const segs = [];
            let prev = A;
            for (const m of macro) {
                const fine = refineLeg(prev, m, { h3, h3Res, hasLandCell, dilateKRings, padDeg, corridorStepDeg, sampleMeters: Math.max(320, sampleMeters) });
                if (fine && fine.length) {
                    if (segs.length === 0) segs.push([prev.lng, prev.lat]);
                    segs.push(...fine);
                    prev = { lng: fine[fine.length - 1][0], lat: fine[fine.length - 1][1] };
                } else {
                    prev = m;
                }
            }
            const tail = refineLeg(prev, B, { h3, h3Res, hasLandCell, dilateKRings, padDeg, corridorStepDeg, sampleMeters: Math.max(320, sampleMeters) });
            if (tail && tail.length) segs.push(...tail);

            if (segs.length) {
                if (routeCoords.length === 0) { if (preDock) routeCoords.push(...preDock); else routeCoords.push([A_CLICK.lng, A_CLICK.lat]); }
                for (const c of segs) routeCoords.push(c);
                if (postDock) { routeCoords.push(postDock[1]); routeCoords.push(postDock[0]); }
                else { routeCoords.push([B.lng, B.lat]); }
                continue;
            }
        }

        // final fallback: recursive GC detours
        const fb = landAwareFallback(A, B, { h3, h3Res, isCellBlocked: isCellBlocked, sampleMeters, bearingStep: 10 }, 0, 8);
        if (!fb || fb.length < 2) throw new Error('No water path found');

        if (routeCoords.length === 0) { if (preDock) routeCoords.push(...preDock); else routeCoords.push([A_CLICK.lng, A_CLICK.lat]); }
        for (const p of fb.slice(1)) routeCoords.push([p.lng, p.lat]);
        if (postDock) { routeCoords.push(postDock[1]); routeCoords.push(postDock[0]); }
    }

    return { type: 'Feature', properties: { kind: 'autoroute' }, geometry: { type: 'LineString', coordinates: routeCoords } };
}
