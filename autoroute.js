// autoroute.js — water-only routing against a Mapbox "land" fill layer
// Exports: autoroute(map, [ [lng,lat], ... ], options)

const sleep = (ms = 0) => new Promise(r => setTimeout(r, ms));

export async function autoroute(map, waypoints, opts = {}) {
    const cfg = {
        // collision detection
        landLayerId: opts.landLayerId || 'land-mask-fill',
        padPx: opts.padPx ?? 3,                 // inflate land hit-box in screen px
        sampleMeters: opts.sampleMeters ?? 1200, // spacing along a candidate segment
        // marching
        stepMetersNear: opts.stepMetersNear ?? 6000,
        stepMetersFar: opts.stepMetersFar ?? 45000,
        coastNearMeters: opts.coastNearMeters ?? 30000, // switch to "near coast" mode inside this
        maxSteps: opts.maxSteps ?? 20000,
        // detour search (spiral around first hit / midpoint)
        detour: {
            startKm: opts.detour?.startKm ?? 6,   // start radius
            endKm: opts.detour?.endKm ?? 600, // max radius
            grow: opts.detour?.grow ?? 1.6, // multiply radius each ring
            angStep: opts.detour?.angStep ?? 10,  // degrees between bearings on a ring
            yieldEveryRings: 1
        },
        // guards / UI
        yieldEvery: opts.yieldEvery ?? 30
    };

    if (!map.getLayer(cfg.landLayerId)) {
        throw new Error(`Land layer not found: ${cfg.landLayerId}`);
    }

    const out = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i];
        const b = waypoints[i + 1];
        const seg = await routeOne(map, a, b, cfg);
        if (i > 0 && seg.length) seg.shift();
        out.push(...seg);
    }

    return {
        type: 'Feature',
        properties: { kind: 'autoroute' },
        geometry: { type: 'LineString', coordinates: out }
    };
}

/* ---------------- core segment router ---------------- */

async function routeOne(map, A, B, cfg) {
    const out = [A];
    let cur = A;
    let steps = 0;

    while (distM(cur, B) > cfg.stepMetersNear && steps < cfg.maxSteps) {
        steps++;
        if (steps % cfg.yieldEvery === 0) await sleep(0);

        const toB = bearing(cur, B);
        const nearCoast = isNearCoast(map, cur, cfg);
        const STEP = nearCoast ? cfg.stepMetersNear : cfg.stepMetersFar;
        const SAMPLE = nearCoast ? cfg.sampleMeters : Math.max(cfg.sampleMeters * 3, 3000);

        // try straight
        let next = dest(cur, STEP, toB);
        if (await segmentIsClear(map, cur, next, cfg, SAMPLE)) {
            out.push(next);
            cur = next;
            continue;
        }

        // tighten straight with binary search
        const okPoint = await straightTighten(map, cur, toB, STEP, cfg, SAMPLE);
        if (okPoint) {
            out.push(okPoint);
            cur = okPoint;
            continue;
        }

        // detour: find a via around the first hit (or midpoint if we missed the hit)
        const via = await findDetour(map, cur, B, cfg, SAMPLE);
        if (via) {
            out.push(via);
            cur = via;
            continue;
        }

        // nothing worked → break out and we’ll try to hop into B if that’s clear
        break;
    }

    if (await segmentIsClear(map, cur, B, cfg, cfg.sampleMeters)) out.push(B);
    return out;
}

/* ---------------- detour search ---------------- */

async function findDetour(map, A, B, cfg, SAMPLE) {
    const hit = await firstHitOnSegment(map, A, B, cfg) || midpoint(A, B);
    const { startKm, endKm, grow, angStep, yieldEveryRings } = cfg.detour;

    // bias around perpendicular to AB (reduces ping-pong and big loops)
    const base = bearing(A, B);
    const preferred = [...angleFan(90, angStep), ...angleFan(-90, angStep)];

    let r = startKm * 1000;
    let ring = 0;

    // spiral outwards
    while (r <= endKm * 1000) {
        ring++;
        // 1) try biased bearings first
        for (const d of preferred) {
            const theta = norm360(base + d);
            const via = dest(hit, r, theta);
            if (isLand(map, via, cfg)) continue;
            const okA = await segmentIsClear(map, A, via, cfg, SAMPLE);
            if (!okA) continue;
            const okB = await segmentIsClear(map, via, B, cfg, SAMPLE);
            if (!okB) continue;
            return via;
        }

        // 2) full sweep around the ring
        for (let ang = 0; ang < 360; ang += angStep) {
            const via = dest(hit, r, ang);
            if (isLand(map, via, cfg)) continue;
            const okA = await segmentIsClear(map, A, via, cfg, SAMPLE);
            if (!okA) continue;
            const okB = await segmentIsClear(map, via, B, cfg, SAMPLE);
            if (!okB) continue;
            return via;
        }

        if (ring % yieldEveryRings === 0) await sleep(0);
        r *= grow;
    }

    // fallback: two-hop coarse guess (left / right)
    const LEFT = dest(hit, startKm * 1500, norm360(base + 90));
    const RIGHT = dest(hit, startKm * 1500, norm360(base - 90));
    const candidates = [LEFT, RIGHT].filter(p => !isLand(map, p, cfg));
    for (const via of candidates) {
        const okA = await segmentIsClear(map, A, via, cfg, SAMPLE);
        const okB = await segmentIsClear(map, via, B, cfg, SAMPLE);
        if (okA && okB) return via;
    }

    throw new Error('No valid detour found');
}

function angleFan(center, step) {
    // e.g. center=90 => [0,180, 15,165, 30,150, ...] mirrored around center
    const arr = [];
    for (let d = 0; d <= 180; d += step) {
        arr.push(center - d);
        if (d) arr.push(center + d);
    }
    return arr;
}

/* ---------------- collision helpers ---------------- */

async function straightTighten(map, cur, toB, STEP, cfg, SAMPLE) {
    let lo = 0, hi = STEP, ok = null;
    for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        const test = dest(cur, mid, toB);
        const clear = await segmentIsClear(map, cur, test, cfg, SAMPLE);
        if (clear) { ok = test; lo = mid; } else { hi = mid; }
        if (hi - lo < Math.max(300, STEP / 250)) break;
    }
    return ok;
}

async function firstHitOnSegment(map, A, B, cfg) {
    const d = distM(A, B);
    const n = clamp(Math.ceil(d / (cfg.sampleMeters * 0.6)), 96, 2048);
    for (let i = 1; i <= n; i++) {
        const p = interp(A, B, i / n);
        if (isLand(map, p, cfg)) return p;
        if (i % 256 === 0) await sleep(0); // keep UI responsive
    }
    return null;
}

async function segmentIsClear(map, A, B, cfg, spacingMeters) {
    const d = distM(A, B);
    const n = clamp(Math.ceil(d / spacingMeters), 4, 4096);
    for (let i = 1; i <= n; i++) {
        const p = interp(A, B, i / n);
        if (isLand(map, p, cfg)) return false;
        if (i % 512 === 0) await sleep(0);
    }
    return true;
}

function isNearCoast(map, p, cfg) {
    // quick ring at ~coastNearMeters checks — if any sample sees land, call it "near"
    const R = cfg.coastNearMeters;
    for (const a of [0, 60, 120, 180, 240, 300]) {
        const q = dest(p, R, a);
        if (isLand(map, q, cfg)) return true;
    }
    return false;
}

function isLand(map, lngLat, cfg) {
    const pt = map.project({ lng: lngLat[0], lat: lngLat[1] });
    const r = Math.max(1, cfg.padPx | 0);
    const min = [pt.x - r, pt.y - r];
    const max = [pt.x + r, pt.y + r];
    const feats = map.queryRenderedFeatures([min, max], { layers: [cfg.landLayerId] });
    return feats && feats.length > 0;
}

/* ---------------- geo utils ---------------- */
const EARTH = 6371008.8;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;
const norm360 = a => ((a % 360) + 360) % 360;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function distM(a, b) {
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
    const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a, b) {
    const φ1 = toRad(a[1]), φ2 = toRad(b[1]);
    const λ1 = toRad(a[0]), λ2 = toRad(b[0]);
    const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
    return norm360(toDeg(Math.atan2(y, x)));
}

function dest(p, distM, brngDeg) {
    const δ = distM / EARTH, θ = toRad(brngDeg);
    const φ1 = toRad(p[1]), λ1 = toRad(p[0]);
    const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
    const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
    const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
    const x = Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2);
    const λ2 = λ1 + Math.atan2(y, x);
    return [((toDeg(λ2) + 540) % 360) - 180, toDeg(φ2)];
}

function interp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function midpoint(a, b) {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
