// autoroute.worker.js - Bloom/H3 land mask with auto-cal + dual-mode retry
// This worker:
// - Holds the land mask Bloom filter in memory
// - Receives routing requests from the main thread
// - Calls the autoroute function to compute a route
// - Tries routing in both land mode and water mode if needed

import { BloomFilter } from 'https://esm.sh/bloom-filters@3.0.4';

let h3 = null;
let autorouteFn = null;
let landBF = null;

let bfMode = 'unknown';         // 'land' | 'water'
let bfCalibratedForRes = null;

const post = (type, payload = {}) => self.postMessage({ type, ...payload });

/** Loads dependencies (H3 and autoroute.js) if not already loaded. */
async function ensureDeps() {
    if (!h3) h3 = await import('https://esm.sh/h3-js@3.7.2');
    if (!autorouteFn) {
        const mod = await import('./autoroute.js');
        autorouteFn = mod.autoroute || mod.default;
        if (typeof autorouteFn !== 'function') throw new Error('autoroute.js did not export { autoroute }');
    }
}

/** Figures out if the Bloom filter is land or water mode by probing known coordinates. */
function calibrateBloom(h3Res) {
    if (!landBF) return;
    if (bfCalibratedForRes === h3Res && bfMode !== 'unknown') return;

    const kansas = h3.geoToH3(38, -100, h3Res);
    const atl = h3.geoToH3(30, -40, h3Res);
    const hasKansas = landBF.has(kansas);
    const hasAtl = landBF.has(atl);

    if (hasKansas && !hasAtl) bfMode = 'land';
    else if (!hasKansas && hasAtl) bfMode = 'water';
    else bfMode = 'land';  // sensible default

    bfCalibratedForRes = h3Res;
    post('inited', { ok: true, bfMode, hasKansas, hasAtlantic: hasAtl, h3Res });
}

/** Returns a hasLandCell function that behaves according to mode ('land' or 'water'). */
function makeHasLandCellForMode(mode) {
    return (cell) => {
        const hit = landBF.has(cell);
        return mode === 'water' ? !hit : hit;
    };
}

/** Runs one routing attempt with a given mode. */
async function tryRouteOnce({ pts, opts, mode }) {
    const { h3Res, dilateKRings, padDeg, sampleMeters, corridorStepDeg, landOverrides = [] } = opts;
    const overrideSet = new Set(landOverrides);
    const hasLandCellRaw = makeHasLandCellForMode(mode);

    const hasLandCell = (cell) => {
        if (overrideSet.has(cell)) return true;
        return hasLandCellRaw(cell);
    };

    const route = await autorouteFn(null, pts, {
        h3, h3Res, hasLandCell, dilateKRings, padDeg, sampleMeters, corridorStepDeg
    });

    return route;
}

// ---------------- Worker message handling ----------------
self.addEventListener('message', async (ev) => {
    const { type } = ev.data || {};
    try {
        if (type === 'init') {
            // Load Bloom filter from main thread
            const { bloomJSON } = ev.data;
            landBF = BloomFilter.fromJSON(bloomJSON);
            post('inited', { ok: true, bfMode: 'unknown' });
            return;
        }

        if (type === 'route') {
            await ensureDeps();

            const { pts, opts } = ev.data;
            if (!pts || pts.length < 2) throw new Error('Need at least two points');

            calibrateBloom(opts.h3Res);
            post('started', { segments: pts.length - 1, bfMode });

            // First try with calibrated mode
            try {
                const route = await tryRouteOnce({ pts, opts, mode: bfMode });
                if (route && route.geometry && route.geometry.coordinates?.length >= 2) {
                    post('route', { route });
                    return;
                }
                throw new Error('empty route');
            } catch (e1) {
                // Retry with flipped mode (land - water)
                const flipped = bfMode === 'land' ? 'water' : 'land';
                const route = await tryRouteOnce({ pts, opts, mode: flipped });
                if (route && route.geometry && route.geometry.coordinates?.length >= 2) {
                    post('route', { route });
                    return;
                }
                throw e1;
            }
        }
    } catch (err) {
        post('error', { message: err?.message || String(err) });
    }
});
