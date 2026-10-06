// terrainfn.js — the open mountain. Pure JavaScript, no three.js, so Web Workers can import it too.
// Coordinates: metres; +y up; the mountain falls toward −z. The start is at the summit (0, ·, 0);
// the valley floor and finish lie near z ≈ −2900. Everything here is deterministic.

export const TILE = 64;                                  // terrain/flora tile size (m)
export const X_MIN = -768, X_MAX = 768;                  // playable world bounds (walls rise beyond ±560)
export const Z_MAX = 192, Z_MIN = -3136;
export const I_MIN = Math.floor(X_MIN / TILE), I_MAX = Math.ceil(X_MAX / TILE) - 1;   // tile i covers x∈[i*TILE,(i+1)*TILE]
export const J_MIN = Math.floor(Z_MIN / TILE), J_MAX = Math.ceil(Z_MAX / TILE) - 1;   // tile j covers z∈[j*TILE,(j+1)*TILE]

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
export function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function hash2(i, j, k = 0) { let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2246822519); h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; }

// Perlin noise (same permutation as the original game, seed 1337)
const perm = new Uint8Array(512);
{ const r = rng(1337), p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) perm[i] = p[i & 255]; }
function grad(h, x, y) { switch (h & 7) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y; case 4: return x; case 5: return -x; case 6: return y; default: return -y; } }
export function noise2(x, y) {
  const X = Math.floor(x), Y = Math.floor(y), xf = x - X, yf = y - Y, xi = X & 255, yi = Y & 255;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const aa = perm[perm[xi] + yi], ab = perm[perm[xi] + yi + 1], ba = perm[perm[xi + 1] + yi], bb = perm[perm[xi + 1] + yi + 1];
  return lerp(lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u), lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u), v);
}
export function fbm(x, y, o) { let s = 0, a = .5, f = 1; for (let i = 0; i < o; i++) { s += a * noise2(x * f, y * f); f *= 2.02; a *= .5; } return s; }

// ───────────────────────── mountains
// Every mountain shares the same playable box; they differ in grade, relief, rock, cliffs, forest and woodwork.
//  grade: mean fall (m per m)  macro/ridge: relief (m)  rock: rock-zone thresholds  step: terrace ledge height (m)
//  cliffs: cliff bands on/off  forest: forest bias  treeline: [s where trees start, s where full]  feat: share of cells with a dirt feature
//  walks: how many freeride boardwalk lines; network: a raised-wood main line through the race course
export const MOUNTAINS = [
  { id: 'ridgeline', name: 'Ridgeline', sub: 'Open mountain · Flowing meadows and forest', grade: .21, macro: 40, ridge: 7, rock: [.12, .32], step: 2.4, cliffs: 0, forest: -.02, treeline: [120, 420], feat: .34, walks: 6, network: false, seed: 0,
    gx: k => 150 * Math.sin(k * .85 - .5) + 35 * Math.sin(k * 2.3) },
  { id: 'widowmaker', name: 'Widowmaker', sub: 'Alpine · Cliff bands, chutes and big drops', trails: [{ name: 'Widowmaker', main: true, w: 1, meander: .3 }], grade: .40, macro: 55, ridge: 14, rock: [0, .22], step: 4, cliffs: 1, trailMax: .9, forest: -.12, treeline: [260, 900], feat: .2, walks: 4, network: false, seed: 1,
    gx: k => 120 * Math.sin(k * .95 + .3) + 30 * Math.sin(k * 2.1) },
  { id: 'freefall', name: 'Freefall', sub: 'World Cup downhill · Three carved race trails', biome: 'ridgeline', grade: .55, macro: 42, ridge: 9, rock: [.18, .38], step: 2, cliffs: 0, forest: .12, treeline: [-60, 80], feat: .1, walks: 3, network: false, seed: 3, trailMax: 1.0,
    trails: [{ name: 'Freefall', main: true, w: 1.05, meander: .35 }, { name: 'Gravity Cavity', w: .95, meander: .55, dx: -150 }, { name: 'Straight Down', w: .9, meander: .12, dx: 160 }],
    gx: k => 70 * Math.sin(k * .9 + .2) + 20 * Math.sin(k * 2.3) },
  { id: 'rampage', name: 'Rampage', sub: 'Desert ridgelines · Freeride lines and huge drops', biome: 'desert', grade: .62, macro: 70, ridge: 42, rock: [-.2, .05], step: 3.2, terrace: .18, cliffs: 1, trailMax: 1.15, forest: -.6, treeline: [9e9, 9e9], feat: .08, walks: 0, network: false, seed: 4,
    trails: [{ name: 'Spine Line', main: true, w: .85, meander: .3 }, { name: 'Canyon Gap', w: .85, meander: .5, dx: -170 }, { name: 'The Fin', w: .75, meander: .2, dx: 175 }],
    gx: k => 80 * Math.sin(k * .7 + 2.1) + 25 * Math.sin(k * 1.9) },
  { id: 'shoreline', name: 'Shoreline', sub: 'Rainforest · Raised wooden singletrack', grade: .31, macro: 26, ridge: 6, rock: [.25, .45], step: 1.6, cliffs: 0, forest: .3, treeline: [-40, 60], feat: .14, walks: 26, network: true, seed: 2,
    gx: k => 90 * Math.sin(k * .8 + 1.1) + 25 * Math.sin(k * 2.7) },
];
for (const m of MOUNTAINS) m.biome = m.biome || m.id;
export let MOUNTAIN = MOUNTAINS[0];
let OX = 0, OZ = 0;                                         // per-mountain noise offsets

// ───────────────────────── race course: start, gates, finish (also used as clear zones)
export const START = { x: 0, z: 0 };
export const GATES = [];
export const FINISH = { x: 0, z: -2900, r: 12 };
function buildCourse() {
  GATES.length = 0;
  for (let k = 1; k <= 13; k++) GATES.push({ x: Math.round(MOUNTAIN.gx(k)), z: -(140 + (k - 1) * 205), r: 7 });
  FINISH.x = Math.round(GATES[GATES.length - 1].x * .4);
}

// how strongly (0..1) the ground must stay flat and clear: start, finish and gate pads
export function padClear(x, z) {
  let c = 0;
  const d0 = Math.hypot(x - START.x, z - START.z); c = Math.max(c, 1 - smooth(22, 40, d0));
  const d1 = Math.hypot(x - FINISH.x, z - FINISH.z); c = Math.max(c, 1 - smooth(40, 70, d1));
  const gi = Math.round((-z - 140) / 205); for (let k = gi - 1; k <= gi + 1; k++) { const g = GATES[k]; if (!g) continue; const d = Math.hypot(x - g.x, z - g.z); c = Math.max(c, 1 - smooth(10, 20, d)); }
  return c;
}
// clear of trees/boulders/features: pads plus a corridor around raised woodwork and the singletrack that links it
export function clearAt(x, z) { return Math.max(padClear(x, z), structClear(x, z), courseClear(x, z)); }
// Ridgeline and Widowmaker: a 4 m corridor along the straight line between consecutive gates stays free of
// trees and boulders (like a taped race line); the ground itself is untouched, cliffs and all.
function courseClear(x, z) {
  if (MOUNTAIN.network || MOUNTAIN.trails || !GATES.length) return 0;
  const k = clamp(Math.floor((-z - 140) / 205) + 1, 0, GATES.length);   // segment index: 0 = start→gate 1
  let c = 0;
  for (let q = k - 1; q <= k + 1; q++) {
    if (q < 0 || q > GATES.length) continue;
    const a = q === 0 ? START : GATES[q - 1], b = q === GATES.length ? FINISH : GATES[q];
    c = Math.max(c, 1 - smooth(2, 5, segDist(x, z, a, b)));
  }
  return c;
}

// ───────────────────────── freeride features: dirt kickers, booters (tables) and rollers, oriented down the fall line
const FCELL = 40;
function featureOf(cx, cz) {
  const r = hash2(cx, cz, 7 + MOUNTAIN.seed * 31); if (r > MOUNTAIN.feat) return null;
  const x = (cx + .25 + .5 * hash2(cx, cz, 8)) * FCELL, z = (cz + .25 + .5 * hash2(cx, cz, 9)) * FCELL;
  const s = -z; if (s < 60 || s > 2820 || Math.abs(x) > 520) return null;
  if (padClear(x, z) > .01 || structClear(x, z) > .01) return null;
  const a = Math.PI + (hash2(cx, cz, 10) - .5) * .7;          // heading (radians, 0 = −z is downhill); see dirOf
  const t = hash2(cx, cz, 11);
  const f = { x, z, ux: -Math.sin(a + Math.PI), uz: -Math.cos(a + Math.PI) };   // unit vector pointing downhill-ish
  if (t < .55) { f.type = 'kicker'; f.h = 1 + 1.1 * hash2(cx, cz, 12); f.L = 4.5 + 3.5 * hash2(cx, cz, 13); f.W = 2.2; }
  else if (t < .8) { f.type = 'booter'; f.h = 1.6 + 1 * hash2(cx, cz, 12); f.up = f.h * 4.2; f.top = 4 + 4 * hash2(cx, cz, 13); f.down = 18; f.W = 3; }
  else { f.type = 'rollers'; f.h = .6 + .4 * hash2(cx, cz, 12); f.w = 7; f.n = 3; f.W = 3.2; }
  f.len = f.type === 'kicker' ? f.L + 1 : f.type === 'booter' ? f.up + f.top + f.down : f.n * f.w;
  return f;
}
// local profile: u = metres along the feature (0 at its uphill start), returns height above the slope
function featureProfile(f, u) {
  if (u < 0 || u > f.len) return 0;
  switch (f.type) {
    case 'kicker': if (u < f.L) return f.h * (u / f.L) ** 2; return f.h * (1 - smooth(f.L, f.L + 1, u));
    case 'booter': { if (u < f.up) return f.h * (u / f.up) ** 2; u -= f.up; if (u < f.top) return f.h; u -= f.top; return f.h * .5 * (1 + Math.cos(Math.PI * u / f.down)); }
    case 'rollers': return f.h * .5 * (1 - Math.cos(2 * Math.PI * u / f.w));
  }
  return 0;
}
// Calls cb(f, u, v) for every feature whose footprint may contain (x,z). u along, v across (metres).
export function forFeatures(x, z, cb) {
  const cx0 = Math.floor(x / FCELL), cz0 = Math.floor(z / FCELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const f = featureOf(cx0 + dx, cz0 + dz); if (!f) continue;
    const px = x - f.x, pz = z - f.z, u = px * f.ux + pz * f.uz, v = -px * f.uz + pz * f.ux;
    if (u < -2 || u > f.len + 2 || Math.abs(v) > f.W + 4) continue;
    cb(f, u, v);
  }
}
export function featureList(x0, z0, x1, z1) {                // features whose origin lies in the box
  const out = [];
  for (let cx = Math.floor(x0 / FCELL); cx <= Math.floor(x1 / FCELL); cx++) for (let cz = Math.floor(z0 / FCELL); cz <= Math.floor(z1 / FCELL); cz++) { const f = featureOf(cx, cz); if (f && f.x >= x0 && f.x < x1 && f.z >= z0 && f.z < z1) out.push(f); }
  return out;
}

// ───────────────────────── height
// rocky zones: bands of natural terraces (ledges = drops), bare rock on their faces
export const rockZone = (x, z) => smooth(MOUNTAIN.rock[0], MOUNTAIN.rock[1], fbm((x + OX) * .006 + 40, (z + OZ) * .006 - 13, 3));
// Cliff bands (Widowmaker): every ~170 m down the fall line a band whose outline wiggles across the slope.
// Height varies along the band: gaps (rideable chutes), 2–5 m drops and 6–16 m cliffs. Each band is a step
// of height H plus a linear ramp of −H across its own 170 m window, so bands never accumulate and the
// ground stays continuous where windows meet.
const BAND = 170;
function cliffH(x, k) { const n = fbm(x * .011 + k * 7.13 + OX * .01, k * 2.91, 2); return smooth(-.06, .04, n) * lerp(2.2, 16, smooth(.08, .38, n)); }
function cliffs(x, z, clr) {
  const s = -z; if (s < 90 || s > 2760) return 0;
  const k0 = Math.round(s / BAND); let h = 0;
  for (let k = k0 - 1; k <= k0 + 1; k++) {
    if (k < 1) continue;
    const sc = k * BAND + 28 * fbm(x * .006 + k * 3.3, k * 1.7 + OZ * .01, 2) * 2, d = s - sc;
    if (Math.abs(d) >= BAND / 2) continue;
    const H = cliffH(x, k) * (1 - clr); if (H <= 0) continue;
    h += H * ((.5 - smooth(-.32, .32, d)) + d / BAND);
  }
  return h;
}
export function cliffAt(x, z) {                              // height (m) of the cliff band step nearest (x,z), 0 if none
  if (!MOUNTAIN.cliffs) return 0; const s = -z, k = Math.round(s / BAND); return k >= 1 ? cliffH(x, k) : 0;
}
function rawHeight(x, z, clr) {
  const M = MOUNTAIN, s = -z, nx = x + OX, nz = z + OZ;
  const sEff = s < 2750 ? s : 2750 + 140 * Math.tanh((s - 2750) / 140);       // valley floor flattens out
  let h = -M.grade * sEff;
  if (s < -30) h += .004 * (s + 30) * (s + 30);                                // summit backside
  h += fbm(nx * .0022 + 3.1, nz * .0022 - 1.7, 4) * M.macro;                  // big hills and hollows
  h += Math.pow(1 - Math.min(1, Math.abs(fbm(nx * .0075 + 11, nz * .0075 + 5, 3) * 1.6)), 3) * M.ridge;   // spines and ridges
  h += .0001 * x * x;                                                          // the mountain drains to the middle
  const ax = Math.abs(x) - 560; if (ax > 0) h += ax * ax * .0035 + ax * .3;   // valley walls at the edges
  // terraces in rocky zones: flat shelves and sharp ledges perpendicular to the fall line
  // (applied before the cliff bands so terraces never get squeezed onto a cliff face)
  const rk = rockZone(x, z) * (1 - Math.max(clr, courseClear(x, z) * .85));
  if (rk > 0) { const st = M.step, hv = h / st, fl = Math.floor(hv), fr = hv - fl; h = lerp(h, (fl + smooth(.8, .98, fr)) * st, rk * .85 * (M.terrace ?? 1)); }
  if (M.cliffs) h += cliffs(x, z, clr);
  h += fbm(nx * .035, nz * .035, 3) * .8 * (1 - .6 * clr);                    // small undulations
  return h;
}
let START_H = 0;
export function heightAt(x, z) {
  const clr = padClear(x, z);
  let h = rawHeight(x, z, clr);
  // start pad on the summit
  const ds = Math.hypot(x - START.x, z - START.z); if (ds < 40) h = lerp(START_H, h, smooth(14, 40, ds));
  h += noise2(x * .55, z * .55) * .05;                                         // fine bumpiness you feel
  forFeatures(x, z, (f, u, v) => { h += featureProfile(f, u) * (1 - smooth(f.W, f.W + 2.5, Math.abs(v))); });
  if (TRAILS.length && !noTrails) { const T = trailAt(x, z); if (T) h = lerp(h, T.tread, T.m); }
  return h;
}
export function startY() { return START_H; }

// ───────────────────────── ground cover
// forest density 0..1 (trees), aspen share 0..1, treeline near the summit, nothing on clear zones
export function forestAt(x, z) {
  const M = MOUNTAIN, s = -z;
  const n = fbm((x + OX) * .006 + 7, (z + OZ) * .006 + 3, 3) + M.forest;
  return smooth(-.02, .16, n) * smooth(M.treeline[0], M.treeline[1], s) * (1 - clearAt(x, z)) * (1 - .75 * rockZone(x, z)) * (1 - smooth(560, 640, Math.abs(x)) * .5);
}
export const aspenAt = (x, z) => MOUNTAIN.id === 'shoreline' ? 0 : smooth(.08, .22, fbm((x + OX) * .02 + 50, (z + OZ) * .02, 2));
// surface weights for physics and the terrain shader: out = [dirt, grass, forestFloor, rock], summing to 1.
// ny = surface normal y (pass 1 if unknown).
export function surfaceInto(x, z, ny, out) {
  const clr = padClear(x, z), TT = TRAILS.length ? trailAt(x, z) : null, trail = Math.max(lineDirt(x, z), TT ? TT.dirt : 0);
  const steep = 1 - smooth(.62, .8, ny);
  const rk = Math.max(steep, rockZone(x, z) * smooth(.15, .55, .5 + noise2(x * .09, z * .09)) * (1 - clr)) * (1 - trail);
  let feat = 0; forFeatures(x, z, (f, u, v) => { if (featureProfile(f, u) > .02 || (u > -3 && u < f.len + 3)) feat = Math.max(feat, 1 - smooth(f.W, f.W + 2, Math.abs(v))); });
  const patches = smooth(.22, .42, fbm(x * .03 + 21, z * .03 - 8, 3));
  let dirt = Math.max(feat, clr * .8, patches * .85 * (MOUNTAIN.id === 'shoreline' ? .3 : 1), trail) * (1 - rk * (1 - trail));
  const forest = forestAt(x, z) * (1 - rk) * (1 - dirt);
  const grass = Math.max(0, 1 - rk - dirt - forest);
  if (TT && TT.rock > 0) { const k = TT.rock * TT.m; out[0] = dirt * (1 - k); out[1] = grass * (1 - k); out[2] = forest * (1 - k); out[3] = rk + (1 - rk) * k; return out; }
  out[0] = dirt; out[1] = grass; out[2] = forest; out[3] = rk;
  return out;
}
// rolling resistance (m/s²) and grip multiplier from surface weights
// Real-world numbers for 2.4" knobbly DH tyres:
//  roll  = Crr·g (m/s²): hardpack ≈ .025, dry grass ≈ .065, forest loam/roots ≈ .055, rock slab ≈ .02
//  grip  = tyre friction μ: hardpack ≈ .95, grass ≈ .72 (slides early), loam ≈ .8, dry rock ≈ 1.0
//  rough = how chattery the ground is (suspension losses, camera buzz): roots and rock gardens most
export function rideFeel(w) {
  return {
    roll: (w[0] * .025 + w[1] * .065 + w[2] * .055 + w[3] * .02) * 9.81,
    grip: w[0] * .95 + w[1] * .72 + w[2] * .8 + w[3] * 1.0,
    rough: w[0] * .12 + w[1] * .3 + w[2] * .6 + w[3] * .75,
  };
}

// ───────────────────────── raised wooden singletrack ("North Shore" woodwork)
// A structure is a polyline sampled every metre: {x, z, y (deck top), g (ground), t (unit tangent tx,tz)}.
//   kind 'boardwalk' (1.3 m wide) or 'skinny' (0.7 m); ends with a ramp down or, if still high, a drop.
// Decks start at ground level, then descend more gently than the ground, so they rise on stilts as the
// slope steepens; past `maxH` the deck ends in a drop. Linking dirt singletrack is stored as 'line' polylines.
export const STRUCTS = [];   // {id, kind, w, pts:[{x,z,y,g,tx,tz}], drop:boolean}
export const LINES = [];     // dirt singletrack polylines [{x,z}] (Shoreline main line between woodwork)
export const COURSE = [];    // Shoreline: the main line in riding order [{x,z,deck:boolean}] (for the steering assist)
const SB = new Map(), LB = new Map(), SBC = 8;                 // spatial buckets for segments
const bkey = (i, j) => (i + 4000) * 10000 + (j + 4000);
function addSeg(map, i0, j0, i1, j1, ref) { for (let i = Math.min(i0, i1) - 1; i <= Math.max(i0, i1) + 1; i++) for (let j = Math.min(j0, j1) - 1; j <= Math.max(j0, j1) + 1; j++) { const k = bkey(i, j); let a = map.get(k); if (!a) map.set(k, a = []); a.push(ref); } }
function walkDeck(x, z, heading, len, r, o) {
  const pts = []; let y = null, dropped = false;
  for (let i = 0; i <= len; i++) {
    if (i) { heading += (r() - .5) * .16 + Math.sin(i * .07 + o.ph) * .02; heading = lerp(heading, o.toward ? o.toward(x, z) : heading, .04); x += -Math.sin(heading); z += -Math.cos(heading); }
    if (Math.abs(x) > 520 || -z > 2840 || -z < 20) break;
    const g = heightAt(x, z);
    if (y === null) y = g; else {
      const ramp = Math.min(1, i / 3);                         // ramp up off the ground over the first 3 m
      y = Math.max(g + .45 * ramp, y - o.desc);
    }
    pts.push({ x, z, y, g, tx: -Math.sin(heading), tz: -Math.cos(heading) });
    if (y - g > o.maxH) { dropped = true; break; }              // high enough: end with a drop
  }
  if (!dropped && pts.length > 6) {                            // ramp down to the ground over the last 4 m
    const n = pts.length; for (let k = 1; k <= 4; k++) { const p = pts[n - k]; p.y = Math.min(p.y, p.g + (p.y - p.g) * (k - 1) / 4); }
    if (pts[n - 1].y - pts[n - 1].g > .25) dropped = true;
  }
  return { pts, drop: dropped };
}
function buildStructures() {
  STRUCTS.length = 0; LINES.length = 0; if (!MOUNTAIN.trails) COURSE.length = 0; SB.clear(); LB.clear();
  const M = MOUNTAIN, r = rng(9000 + M.seed * 77);
  const add = (st) => { if (st.pts.length < 8) return; st.id = STRUCTS.length; STRUCTS.push(st);
    for (let i = 0; i < st.pts.length - 1; i++) { const a = st.pts[i], b = st.pts[i + 1]; addSeg(SB, Math.floor(a.x / SBC), Math.floor(a.z / SBC), Math.floor(b.x / SBC), Math.floor(b.z / SBC), [st.id, i]); } };
  if (M.network) {
    // Shoreline: one main line from the start through every gate to the finish. It alternates raised woodwork
    // and dirt singletrack; gates always sit on dirt.
    const wps = [{ x: START.x, z: START.z - 30 }, ...GATES, FINISH];
    for (let w = 0; w < wps.length - 1; w++) {
      const A = wps[w], B = wps[w + 1];
      const toward = (x, z) => Math.atan2(-(B.x - x), -(B.z - z));
      let x = A.x, z = A.z, heading = toward(x, z); const line = [{ x, z }];
      let guard = 0;
      while (Math.hypot(B.x - x, B.z - z) > 30 && guard++ < 40) {
        // dirt run
        const run = 12 + r() * 20;
        for (let i = 0; i < run && Math.hypot(B.x - x, B.z - z) > 30; i++) { heading = lerp(heading, toward(x, z), .08) + (r() - .5) * .05; x += -Math.sin(heading); z += -Math.cos(heading); line.push({ x, z }); COURSE.push({ x, z, deck: false }); }
        if (Math.hypot(B.x - x, B.z - z) < 45) break;
        // woodwork run
        const len = Math.min(30 + r() * 60, Math.hypot(B.x - x, B.z - z) - 30);
        const st = walkDeck(x, z, heading, len, r, { desc: .12 + r() * .08, maxH: 2.8 + r() * 2.4, ph: r() * 6, toward });
        st.kind = 'boardwalk'; st.w = 1.4; st.main = true; add(st); for (const p of st.pts) COURSE.push({ x: p.x, z: p.z, deck: true });
        const e = st.pts[st.pts.length - 1]; if (!e) break;
        // after a drop, continue on the ground a few metres further on
        x = e.x + e.tx * (st.drop ? 5 + (e.y - e.g) * 1.2 : 1); z = e.z + e.tz * (st.drop ? 5 + (e.y - e.g) * 1.2 : 1); heading = Math.atan2(-e.tx, -e.tz);
        for (let i = 0; i < 3; i++) line.push({ x: x - e.tx * (2 - i), z: z - e.tz * (2 - i), gap: i === 0 });
      }
      line.push({ x: B.x, z: B.z }); COURSE.push({ x: B.x, z: B.z, deck: false }); LINES.push(line);
    }
    for (const line of LINES) for (let i = 0; i < line.length - 1; i++) { const a = line[i], b = line[i + 1]; if (b.gap) continue; addSeg(LB, Math.floor(a.x / SBC), Math.floor(a.z / SBC), Math.floor(b.x / SBC), Math.floor(b.z / SBC), [LINES.indexOf(line), i]); }
  }
  // freeride woodwork scattered through the forest: boardwalks that end in drops, and the odd skinny log ride
  for (let n = 0, tries = 0; n < M.walks && tries < M.walks * 40; tries++) {
    const x = (r() - .5) * 900, z = -(150 + r() * 2550);
    if (padClear(x, z) > 0 || structClear(x, z) > 0) continue;
    if (M.id !== 'shoreline' && forestAt(x, z) < .3 && r() < .7) continue;     // mostly in the trees
    const skinny = r() < .22, len = skinny ? 14 + r() * 16 : 25 + r() * 55;
    const st = walkDeck(x, z, Math.PI * 0 + (r() - .5) * .9, len, r, { desc: skinny ? .3 : .1 + r() * .1, maxH: skinny ? 1.6 : 2.5 + r() * 3.5, ph: r() * 6 });
    st.kind = skinny ? 'skinny' : 'boardwalk'; st.w = skinny ? .7 : 1.3;
    let ok = st.pts.length >= 10; for (const p of st.pts) if (padClear(p.x, p.z) > 0) ok = false;
    if (ok) { add(st); n++; }
  }
}
// Nearest structure segment info at (x,z): calls cb(st, i, u (0..1 along segment), lat (m, signed), along (m from start))
function forSegs(map, x, z, cb) { const a = map.get(bkey(Math.floor(x / SBC), Math.floor(z / SBC))); if (a) for (const ref of a) cb(ref[0], ref[1]); }
// The deck surface the rider is on or about to roll onto: the highest deck whose footprint contains (x,z)
// and whose top is not more than 0.5 m above yRef (so you can ride under a high deck).
// Returns {y, st, lat, w, tx, tz} or null.
export function deckAt(x, z, yRef) {
  let best = null;
  forSegs(SB, x, z, (sid, i) => {
    const st = STRUCTS[sid], a = st.pts[i], b = st.pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1, u = ((x - a.x) * dx + (z - a.z) * dz) / L2;
    if (u < 0 || u > 1) return;
    const lat = (-(x - a.x) * dz + (z - a.z) * dx) / Math.sqrt(L2);
    if (Math.abs(lat) > st.w / 2) return;
    const y = lerp(a.y, b.y, u); if (y > yRef + .5) return;
    if (!best || y > best.y) best = { y, st, lat, w: st.w, tx: a.tx, tz: a.tz, i, u };
  });
  return best;
}
// 0..1: keep trees and features out of woodwork corridors and the dirt singletrack
export function structClear(x, z) {
  let c = 0;
  forSegs(SB, x, z, (sid, i) => { const st = STRUCTS[sid], a = st.pts[i], b = st.pts[i + 1]; const d = segDist(x, z, a, b); c = Math.max(c, 1 - smooth(st.w / 2 + 1.2, st.w / 2 + 3.5, d)); });
  forSegs(LB, x, z, (li, i) => { const a = LINES[li][i], b = LINES[li][i + 1]; const d = segDist(x, z, a, b); c = Math.max(c, 1 - smooth(1.6, 3.6, d)); });
  if (TRAILS.length) { const T = trailAt(x, z); if (T) c = Math.max(c, 1 - smooth(T.w + 1.2, T.w + 3.8, Math.abs(T.lat))); }
  return c;
}
// dirt singletrack surface weight (0..1): a 1.2 m wide packed line with soft edges
function lineDirt(x, z) { let c = 0; forSegs(LB, x, z, (li, i) => { const a = LINES[li][i], b = LINES[li][i + 1]; c = Math.max(c, 1 - smooth(.6, 1.4, segDist(x, z, a, b))); }); return c; }
function segDist(x, z, a, b) { const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1; const u = clamp(((x - a.x) * dx + (z - a.z) * dz) / L2, 0, 1); return Math.hypot(x - a.x - u * dx, z - a.z - u * dz); }
// Stilts: posts at both deck edges every 2.4 m wherever the deck is more than 0.5 m above the ground.
// Returns [{x, z, y0 (ground), y1 (deck underside), st}] for posts inside the box. Used for colliders and rendering.
export function postsIn(x0, z0, x1, z1) {
  const out = [];
  for (const st of STRUCTS) { let acc = 0;
    for (let i = 1; i < st.pts.length; i++) { const p = st.pts[i]; acc += 1; if (acc < 2.4) continue; acc = 0; if (p.y - p.g < .5) continue;
      for (const sd of [-1, 1]) { const px = p.x + p.tz * sd * (st.w / 2 - .08) * -1, pz = p.z + p.tx * sd * (st.w / 2 - .08); if (px < x0 || px >= x1 || pz < z0 || pz >= z1) continue; out.push({ x: px, z: pz, y0: heightAt(px, pz), y1: p.y - .12, st: st.id }); } } }
  return out;
}
// riding on wood: fast-rolling, less grip than dirt (it's often damp), smooth
export const WOOD_FEEL = { roll: .018 * 9.81, grip: .78, rough: .08 };

// ───────────────────────── carved downhill trails
// A trail is a 1 m polyline benched into the hillside. Its tread height is the raw ground smoothed along
// the line (so it reads as a built trail), plus features: step-down drops (a lip held up before, a steep
// landing after), rock rolls (a 2–4 m rock face over 3 m) and rock gardens (bumpy, rocky). Turns get a
// banked tread and a berm wall on the outside. heightAt() blends the tread into the hillside over ~4 m.
export const TRAILS = [];    // {name, main, w (half width), pts:[{x,z,y,tx,tz,bank,berm,garden,roll}]}
const TB = new Map();
let noTrails = false;
// the ground a trail is cut into: everything heightAt does (start pad, features) except the trails themselves
function rawAt(x, z) { noTrails = true; const h = heightAt(x, z); noTrails = false; return h; }
function genTrail(wps, r, spec) {
  const pts = []; let x = wps[0].x, z = wps[0].z, ph = r() * 6;
  for (let w = 1; w < wps.length; w++) {
    const B = wps[w]; let guard = 0;
    while (Math.hypot(B.x - x, B.z - z) > 1.2 && guard++ < 4000) {
      const left = Math.hypot(B.x - x, B.z - z), toward = Math.atan2(-(B.x - x), -(B.z - z));
      const hd = toward + spec.meander * Math.sin(pts.length * .045 + ph) * smooth(10, 70, left) + spec.meander * .4 * Math.sin(pts.length * .13 + ph * 2) * smooth(10, 40, left);
      x += -Math.sin(hd); z += -Math.cos(hd);
      if (Math.abs(x) > 540) x = Math.sign(x) * 540;
      pts.push({ x, z, g: rawAt(x, z), garden: 0, roll: 0 });
    }
  }
  const n = pts.length; if (n < 20) return null;
  // smooth the ground along the line (±6 m), never steeper than the ground's own fall over that window
  const W = 6, ys = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0, k = 0; for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) { s += pts[j].g; k++; } ys[i] = s / k; }
  // cap the sustained steepness: average a "fill" pass (never descends faster than maxG) and a "cut" pass
  // (the same constraint run from the bottom), so the line cuts into steep faces about as much as it builds up
  { const g = MOUNTAIN.trailMax || 1, F = new Float32Array(n), Bk = new Float32Array(n);
    F[0] = ys[0]; for (let i = 1; i < n; i++) F[i] = Math.max(ys[i], F[i - 1] - g);
    Bk[n - 1] = ys[n - 1]; for (let i = n - 2; i >= 0; i--) Bk[i] = Math.min(ys[i], Bk[i + 1] + g);
    for (let i = 0; i < n; i++) ys[i] = (F[i] + Bk[i]) / 2; }
  // features down the trail
  const off = new Float32Array(n);
  for (let k = 30 + Math.floor(r() * 30); k < n - 30; k += 38 + Math.floor(r() * 50)) {
    if (padClear(pts[k].x, pts[k].z) > 0) continue;
    const t = r();
    if (t < .42) {                                              // step-down drop
      const dh = 1.3 + r() * 1.9; pts[k].drop = dh;
      for (let j = k - 14; j < k + 20; j++) { if (j < 0 || j >= n) continue; off[j] += j < k ? dh * .5 * smooth(k - 14, k - 1, j) : -dh * .5 * (1 - smooth(k + 1, k + 20, j)); }
    } else if (t < .72) {                                       // rock roll
      const dh = 2 + r() * 2.2;
      for (let j = k - 12; j < k + 18; j++) { if (j < 0 || j >= n) continue;
        off[j] += j < k ? dh * .5 * smooth(k - 12, k, j) : j < k + 3 ? lerp(dh * .5, -dh * .5, (j - k) / 3) : -dh * .5 * (1 - smooth(k + 3, k + 18, j));
        if (j >= k - 1 && j <= k + 4) pts[j].roll = 1; }
    } else {                                                    // rock garden
      const L = 14 + Math.floor(r() * 16); for (let j = k; j < Math.min(n, k + L); j++) pts[j].garden = smooth(k, k + 3, j) * (1 - smooth(k + L - 3, k + L, j));
    }
  }
  for (let i = 0; i < n; i++) pts[i].y = ys[i] + off[i];
  // tangents, curvature → banked tread and berms
  for (let i = 0; i < n; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1; pts[i].tx = (b.x - a.x) / L; pts[i].tz = (b.z - a.z) / L; }
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 4)], b = pts[Math.min(n - 1, i + 4)];
    const k = wrapPi(Math.atan2(-b.tx, -b.tz) - Math.atan2(-a.tx, -a.tz)) / 8;   // + = turning left
    pts[i].bank = clamp(k * 9, -.42, .42); pts[i].berm = clamp(Math.abs(k) * 28, 0, 1) * 1.1;
  }
  return { name: spec.name, main: !!spec.main, w: spec.w, pts };
}
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function buildTrails() {
  TRAILS.length = 0; TB.clear(); if (!MOUNTAIN.trails) return;
  COURSE.length = 0; const r = rng(5100 + MOUNTAIN.seed * 13);
  for (const spec of MOUNTAIN.trails) {
    let wps;
    if (spec.main) wps = [{ x: START.x, z: START.z - 18 }, ...GATES.map(g => ({ x: g.x, z: g.z })), { x: FINISH.x, z: FINISH.z }];
    else { wps = [{ x: START.x + spec.dx * .25, z: START.z - 30 }]; for (let s = 220; s < 2800; s += 230) wps.push({ x: spec.dx + 60 * Math.sin(s / 300 + spec.dx), z: -s }); wps.push({ x: FINISH.x + spec.dx * .2, z: FINISH.z + 20 }); }
    const T = genTrail(wps, r, spec); if (!T) continue;
    T.id = TRAILS.length; TRAILS.push(T);
    for (let i = 0; i < T.pts.length - 1; i++) { const a = T.pts[i], b = T.pts[i + 1]; addSeg(TB, Math.floor(a.x / SBC), Math.floor(a.z / SBC), Math.floor(b.x / SBC), Math.floor(b.z / SBC), [T.id, i]); }
    if (spec.main) for (const p of T.pts) COURSE.push({ x: p.x, z: p.z, deck: false, trail: true });
  }
}
// nearest trail cross-section at (x,z): {tread (height), m (blend 0..1), lat, w, dirt, rock} or null
export function trailAt(x, z) {
  let best = null, bd = 6.5;
  forSegs(TB, x, z, (tid, i) => {
    const T = TRAILS[tid], a = T.pts[i], b = T.pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1, u = clamp(((x - a.x) * dx + (z - a.z) * dz) / L2, 0, 1);
    const px = a.x + u * dx - x, pz = a.z + u * dz - z, d = Math.hypot(px, pz); if (d >= bd) return;
    bd = d; best = { T, a, b, u, lat: (-(x - a.x) * dz + (z - a.z) * dx) / Math.sqrt(L2) };
  });
  if (!best) return null;
  const { T, a, b, u, lat } = best, w = T.w, al = Math.abs(lat);
  const y = lerp(a.y, b.y, u), bank = lerp(a.bank, b.bank, u), berm = lerp(a.berm, b.berm, u), garden = lerp(a.garden, b.garden, u), roll = Math.max(a.roll, b.roll);
  let tread = y + bank * lat - .07 * Math.exp(-(((al - .32) / .11) ** 2)) * (1 - garden);    // two tyre ruts
  if (garden > 0) tread += garden * (noise2(x * 1.9, z * 1.9) * .32 + noise2(x * 4.1, z * 4.1) * .12);
  if (lat * bank > 0) tread += berm * smooth(w * .5, w + 1, al);                             // berm wall on the outside
  return { tread, m: 1 - smooth(w + .5, w + 4.5, al), lat, w, dirt: 1 - smooth(w - .1, w + .7, al), rock: Math.max(garden, roll) * (1 - smooth(w, w + 1.5, al)), T };
}

// ───────────────────────── skinnies: a balance course of narrow raised planks near the start
// A chain of sections, each its own structure (kind 'skinny' unless noted), built heading roughly across the
// slope beside the start. Section heights are above the ground smoothed along the course, so ladders
// rise on stilts and the line stays rideable. The last section ends in a drop to the ground.
export const BALANCE = { sections: [], start: null, finish: null };
function buildBalance() {
  BALANCE.sections = []; BALANCE.start = null; BALANCE.finish = null;
  // [length m, width m, height above the reference line m, turn (rad over the section), gap before (m), kind]
  const plan = [
    [8, .9, .45, 0, 0, 'boardwalk'],         // wide entry deck
    [10, .5, .7, .2, 0, 'skinny'],           // first skinny, gentle curve
    [5, 1, .9, -.6, 0, 'boardwalk'],         // turning platform
    [9, .45, 2.1, 0, 0, 'skinny'],           // ladder up
    [8, .4, 2.2, .12, 0, 'skinny'],          // high skinny
    [5, .9, 2.2, .55, 0, 'boardwalk'],       // high platform turn
    [7, .45, 2.1, 0, .7, 'skinny'],          // hop the gap
    [11, .32, 1.6, -.25, 0, 'skinny'],       // very narrow, curving down
    [6, .45, 1.2, .3, 0, 'skinny'],          // kink left
    [6, .45, 1, -.55, 0, 'skinny'],          // kink right
    [10, .38, 1.1, 0, 0, 'log'],             // split-log ride
    [5, .8, 1.5, 0, 0, 'boardwalk'],         // run-out to the drop
  ];
  const total = plan.reduce((a, p) => a + p[0] + p[4], 0);
  // pick a spot and heading beside the start where the ground falls gently and steadily along the course,
  // clear of the race trail, woodwork and pads
  let best = null;
  for (const [dx, dz] of [[-95, -55], [95, -55], [-120, -110], [120, -110], [-70, -160], [70, -160], [-150, -60], [150, -60]]) {
    for (let h = -1.4; h <= 1.4; h += .2) {
      const ox = START.x + dx, oz = START.z + dz, fx = -Math.sin(h), fz = -Math.cos(h);
      let clear = true, g0 = heightAt(ox, oz), rise = 0, prev = g0;
      for (let s = 0; s <= total + 8; s += 4) { const x = ox + fx * s, z = oz + fz * s; if (padClear(x, z) > 0 || structClear(x, z) > 0 || Math.abs(x) > 520) { clear = false; break; } const g = heightAt(x, z); rise = Math.max(rise, g - prev); prev = g; }
      if (!clear) continue;
      const drop = g0 - heightAt(ox + fx * total, oz + fz * total), grade = drop / total;
      const score = Math.abs(grade - .08) * 10 + rise * .5;
      if (grade > 0 && (!best || score < best.score)) best = { ox, oz, h, score, grade };
    }
  }
  if (!best) return;
  let x = best.ox, z = best.oz, h = best.h, along = 0;
  const g0 = heightAt(x, z), grade = Math.min(best.grade, .16), ref = s => g0 - grade * s;   // the gently falling reference line
  BALANCE.start = { x: x + Math.sin(h) * 5, z: z + Math.cos(h) * 5, th: h };
  let prevY = g0;
  for (let si = 0; si < plan.length; si++) {
    const [L, w, ht, turn, gap, kind] = plan[si];
    if (gap) { x += -Math.sin(h) * gap; z += -Math.cos(h) * gap; along += gap; }
    const pts = [], n = Math.max(2, Math.round(L)), h0 = h, y0 = prevY;
    for (let i = 0; i <= n; i++) {
      if (i) { h = h0 + turn * i / n; x += -Math.sin(h) * L / n; z += -Math.cos(h) * L / n; along += L / n; }
      const g = heightAt(x, z), target = ref(along) + ht;
      let y = lerp(y0, target, smooth(0, 1, i / n));
      if (si === 0) y = lerp(g, target, smooth(0, .7, i / n));                // ramp up off the ground
      y = clamp(y, g + (si === 0 && i < 2 ? 0 : .25), g + 3.5);
      pts.push({ x, z, y, g, tx: -Math.sin(h), tz: -Math.cos(h) });
    }
    prevY = pts[pts.length - 1].y;
    const st = { kind: kind === 'log' ? 'skinny' : kind, log: kind === 'log', w, pts, drop: si === plan.length - 1, balance: si };
    st.id = STRUCTS.length; STRUCTS.push(st);
    for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1]; addSeg(SB, Math.floor(a.x / SBC), Math.floor(a.z / SBC), Math.floor(b.x / SBC), Math.floor(b.z / SBC), [st.id, i]); }
    BALANCE.sections.push(st.id);
  }
  const e = STRUCTS[BALANCE.sections[BALANCE.sections.length - 1]].pts.at(-1);
  BALANCE.finish = { x: e.x + e.tx * 6, z: e.z + e.tz * 6 };
}

// ───────────────────────── switching mountains
// Call setMountain(id) (also inside workers) before using anything above. Deterministic per mountain.
export function setMountain(id) {
  MOUNTAIN = MOUNTAINS.find(m => m.id === id) || MOUNTAINS[0];
  OX = MOUNTAIN.seed * 1013.7; OZ = MOUNTAIN.seed * -733.1;
  buildCourse(); STRUCTS.length = 0; LINES.length = 0; SB.clear(); LB.clear(); TRAILS.length = 0; TB.clear();
  START_H = rawHeight(START.x, START.z, 1);
  buildTrails();
  buildStructures();
  buildBalance();
  return MOUNTAIN;
}
setMountain('ridgeline');
