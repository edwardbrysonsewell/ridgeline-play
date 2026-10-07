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
  // Razorback: high-alpine big-mountain freeride on granite — slabs, a knife-edge crest and cliff faces, but no boulder
  // fields: scattered rocks are kept off the lines (a few clusters under the cliffs). The main line is a designed corridor
  // (see "Razorback" below): a granite roll-in off the summit, a 340 m knife-edge spine, two huge roll-off cliff drops,
  // a 40° couloir, a canyon gap, a run of bermed S-turns, a 42° slab and a 38° fall-line plunge through the larches.
  { id: 'razorback', name: 'Razorback', sub: 'High alpine · Knife-edge spine, cliff drops and a canyon gap', biome: 'alpine', grade: .5, macro: 60, ridge: 20, rock: [.28, .5], step: 5, terrace: .22, cliffs: 0, trailMax: 1.0, forest: .04, treeline: [480, 1300], feat: 0, walks: 0, network: false, seed: 5,
    corridor: 'razorback', trails: [{ name: 'Razorback', main: true, w: 1.15, meander: 0 }, { name: 'Goat Track', w: .95, meander: .45, dx: -205 }, { name: 'Scree Run', w: .9, meander: .3, dx: 210 }],
    gx: k => rzX(140 + (k - 1) * 205) },
  // Hollowfell: a steep highland downhill venue. Open heather moor on top — big fast berms, two huge dirt jumps and a dirt
  // step-down — then dark, wet conifer forest: loamy fall-line chutes, off-camber traverses, tight switchbacks with big catch
  // berms, roots and compressions. Dirt, loam and grass underfoot; rock is rare. Jump line left, raw tech line right.
  { id: 'hollowfell', name: 'Hollowfell', sub: 'Highland forest · Steep loam, roots and huge dirt jumps', biome: 'highland', grade: .5, fall: s => .4 * s + .2 * (s - 1400) * smooth(1100, 1700, s), macro: 45, ridge: 10, rock: [.32, .55], step: 3, terrace: .15, cliffs: 0, trailMax: 1.0, forest: .45, treeline: [620, 900], feat: 0, walks: 0, network: false, seed: 6,
    corridor: 'hollowfell', trails: [{ name: 'Hollowfell', main: true, w: 1.1, meander: 0, bermX: 1.6, bermW: 2.4 }, { name: 'Air Line', w: 1.05, meander: .4, dx: -200, style: 'jump' }, { name: 'The Gnarl', w: .8, meander: .6, dx: 205, style: 'tech' }],
    gx: k => rzX(140 + (k - 1) * 205) },
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
  let h = M.fall ? -M.fall(sEff) : -M.grade * sEff;                          // (a mountain may shape its long fall)
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
  if (RZ.on) h = rzShape(x, z, h);                                             // Razorback's designed line
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
  const f = smooth(-.02, .16, n) * smooth(M.treeline[0], M.treeline[1], s) * (1 - clearAt(x, z)) * (1 - .75 * rockZone(x, z)) * (1 - smooth(560, 640, Math.abs(x)) * .5);
  return RZ.on && f > 0 ? f * (1 - rzRock(x, z)) : f;
}
export const aspenAt = (x, z) => MOUNTAIN.id === 'shoreline' ? 0 : smooth(.08, .22, fbm((x + OX) * .02 + 50, (z + OZ) * .02, 2));
// surface weights for physics and the terrain shader: out = [dirt, grass, forestFloor, rock], summing to 1.
// ny = surface normal y (pass 1 if unknown).
export function surfaceInto(x, z, ny, out) {
  const clr = padClear(x, z), TT = TRAILS.length ? trailAt(x, z) : null, trail = Math.max(lineDirt(x, z), TT ? TT.dirt : 0);
  const steep = 1 - smooth(.62, .8, ny);
  let rk = Math.max(steep, rockZone(x, z) * smooth(.15, .55, .5 + noise2(x * .09, z * .09)) * (1 - clr)) * (1 - trail);
  if (RZ.on) rk = Math.max(rk, rzRock(x, z) * (1 - trail));
  let feat = 0; forFeatures(x, z, (f, u, v) => { if (featureProfile(f, u) > .02 || (u > -3 && u < f.len + 3)) feat = Math.max(feat, 1 - smooth(f.W, f.W + 2, Math.abs(v))); });
  if (RZ.on) { const dz = rzDirt(x, z); if (dz > 0) { rk *= 1 - dz; feat = Math.max(feat, dz); } }   // built dirt jumps stay dirt, faces and all
  const patches = smooth(.22, .42, fbm(x * .03 + 21, z * .03 - 8, 3));
  let dirt = Math.max(feat, clr * .8, patches * .85 * (MOUNTAIN.id === 'shoreline' ? .3 : 1), trail) * (1 - rk * (1 - trail));
  const forest = forestAt(x, z) * (1 - rk) * (1 - dirt);
  const grass = Math.max(0, 1 - rk - dirt - forest);
  if (TT && TT.rock > 0) { const k = TT.rock * TT.m; out[0] = dirt * (1 - k); out[1] = grass * (1 - k); out[2] = forest * (1 - k); out[3] = rk + (1 - rk) * k; return out; }
  out[0] = dirt; out[1] = grass; out[2] = forest; out[3] = rk;
  return out;
}
// rolling resistance (m/s²) and grip multiplier from surface weights, for 2.4–2.5" knobbly DH tyres.
//  roll  = Crr·g (m/s²): hardpack ≈ .03 (DH casings roll ~10 % worse than trail tyres), grass ≈ .045, forest loam ≈ .055,
//          rock slab ≈ .02. Coast-down tests on dirt trails measure 0.04–0.05 g all-in (Beck 2004); mixed off-road ≈ .022–.03.
//  grip  = tyre friction μ: hardpack ≈ .85, dry grass ≈ .55 (slides early), loam ≈ .70, dry rock ≈ .95. No bike-tyre-on-dirt
//          μ is published; proxies: car tyre on loose moist dirt 0.6–0.65, dirt road 0.35, lab MTB tyre on sandpaper ~1.3.
//  rough = how chattery the ground is (suspension losses, camera buzz): roots and rock gardens most
//  (WOOD_FEEL, the riding feel on woodwork, is unchanged by this pass.)
export function rideFeel(w) {
  return {
    roll: (w[0] * .03 + w[1] * .045 + w[2] * .055 + w[3] * .02) * 9.81,
    grip: w[0] * .85 + w[1] * .55 + w[2] * .70 + w[3] * .95,
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
  if (spec.path) for (const q of spec.path) pts.push({ x: q.x, z: q.z, g: rawAt(q.x, q.z), garden: q.rz.roots || 0, roll: 0, rz: q.rz });   // a designed line
  else for (let w = 1; w < wps.length; w++) {
    const B = wps[w]; let guard = 0;
    while (Math.hypot(B.x - x, B.z - z) > 1.2 && guard++ < 4000) {
      const left = Math.hypot(B.x - x, B.z - z), toward = Math.atan2(-(B.x - x), -(B.z - z));
      const hd = toward + spec.meander * Math.sin(pts.length * .045 + ph) * smooth(10, 70, left) + spec.meander * .4 * Math.sin(pts.length * .13 + ph * 2) * smooth(10, 40, left);
      x += -Math.sin(hd); z += -Math.cos(hd);
      if (Math.abs(x) > 540) x = Math.sign(x) * 540;
      pts.push(MOUNTAIN.corridor ? { x, z, g: rawAt(x, z), garden: 0, roll: 0, rz: RZ_OFF } : { x, z, g: rawAt(x, z), garden: 0, roll: 0 });
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
    if (spec.path) {   // designed sections are exact: the caps restart after each one instead of filling its drops
      F[0] = ys[0]; for (let i = 1; i < n; i++) F[i] = pts[i].rz.fix > .5 ? ys[i] : Math.max(ys[i], F[i - 1] - g);
      Bk[n - 1] = ys[n - 1]; for (let i = n - 2; i >= 0; i--) Bk[i] = pts[i].rz.fix > .5 ? ys[i] : Math.min(ys[i], Bk[i + 1] + g);
    }
    for (let i = 0; i < n; i++) ys[i] = (F[i] + Bk[i]) / 2; }
  // features down the trail
  const off = new Float32Array(n);
  for (let k = 30 + Math.floor(r() * 30); k < n - 30; k += 38 + Math.floor(r() * 50)) {
    if (padClear(pts[k].x, pts[k].z) > 0) continue;
    const t = r();
    if (spec.path) { let near = 0; for (let j = Math.max(0, k - 30); j < Math.min(n, k + 30); j++) near = Math.max(near, pts[j].rz.fix); if (near > 0) continue; }
    if (spec.style === 'jump' && t < .7) {                     // jump line: dirt tabletops (kicker 1.3–2.1 m, 7–12 m deck, 9 m landing)
      const hk = 1.3 + r() * .8, deck = 7 + Math.floor(r() * 6);
      for (let j = k - 8; j < k + deck + 10; j++) { if (j < 0 || j >= n) continue; const a = j - k;
        off[j] += a < 0 ? hk * smooth(-8, 0, a) : a < deck ? hk : hk * (1 - smooth(deck, deck + 10, a)); }
      continue;
    }
    if (spec.style === 'tech' && t >= .42) {                   // tech line: roots instead of rolls and gardens, longer
      const L = 20 + Math.floor(r() * 24); for (let j = k; j < Math.min(n, k + L); j++) pts[j].garden = Math.max(pts[j].garden, smooth(k, k + 3, j) * (1 - smooth(k + L - 3, k + L, j)));
      continue;
    }
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
  if (spec.path) for (let i = 0; i < n; i++) { const q = pts[i].rz; pts[i].y = lerp(pts[i].y, pts[i].g, q.fix); if (q.lip) pts[i].drop = q.lip; }
  // tangents, curvature → banked tread and berms
  for (let i = 0; i < n; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1; pts[i].tx = (b.x - a.x) / L; pts[i].tz = (b.z - a.z) / L; }
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 4)], b = pts[Math.min(n - 1, i + 4)];
    const k = wrapPi(Math.atan2(-b.tx, -b.tz) - Math.atan2(-a.tx, -a.tz)) / 8;   // + = turning left
    pts[i].bank = clamp(k * 9, -.42, .42); pts[i].berm = clamp(Math.abs(k) * 28, 0, 1) * 1.1;
    if (spec.path) { const f = 1 - pts[i].rz.fix; pts[i].bank *= f; pts[i].berm *= f; pts[i].bank += pts[i].rz.cam || 0; }
    if (spec.bermX) pts[i].berm *= spec.bermX;   // big catch berms
  }
  return spec.bermW ? { name: spec.name, main: !!spec.main, w: spec.w, pts, bermW: spec.bermW } : { name: spec.name, main: !!spec.main, w: spec.w, pts };
}
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function buildTrails() {
  TRAILS.length = 0; TB.clear(); if (!MOUNTAIN.trails) return;
  COURSE.length = 0; const r = rng(5100 + MOUNTAIN.seed * 13);
  for (let spec of MOUNTAIN.trails) {
    let wps;
    if (spec.main) wps = [{ x: START.x, z: START.z - 18 }, ...GATES.map(g => ({ x: g.x, z: g.z })), { x: FINISH.x, z: FINISH.z }];
    else { wps = [{ x: START.x + spec.dx * .25, z: START.z - 30 }]; for (let s = 220; s < 2800; s += 230) wps.push({ x: spec.dx + 60 * Math.sin(s / 300 + spec.dx), z: -s }); wps.push({ x: FINISH.x + spec.dx * .2, z: FINISH.z + 20 }); }
    if (spec.main && RZ.on) spec = { ...spec, path: rzPath() };
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
  if (best.a.rz) return rzTrail(best, x, z);
  const { T, a, b, u, lat } = best, w = T.w, al = Math.abs(lat);
  const y = lerp(a.y, b.y, u), bank = lerp(a.bank, b.bank, u), berm = lerp(a.berm, b.berm, u), garden = lerp(a.garden, b.garden, u), roll = Math.max(a.roll, b.roll);
  let tread = y + bank * lat - .07 * Math.exp(-(((al - .32) / .11) ** 2)) * (1 - garden);    // two tyre ruts
  if (garden > 0) tread += garden * (noise2(x * 1.9, z * 1.9) * .32 + noise2(x * 4.1, z * 4.1) * .12);
  if (lat * bank > 0) tread += berm * smooth(w * .5, w + 1, al);                             // berm wall on the outside
  return { tread, m: 1 - smooth(w + .5, w + 4.5, al), lat, w, dirt: 1 - smooth(w - .1, w + .7, al), rock: Math.max(garden, roll) * (1 - smooth(w, w + 1.5, al)), T };
}

// ───────────────────────── Razorback: a designed big-mountain line
// Razorback's main line is a corridor down the mountain, x = rzX(s) at depth s = −z. Its long profile Y(s) is designed
// section by section (RZ_PLANS) instead of following the noise terrain, and rawHeight reshapes the ground around it, so
// physics, the terrain mesh, flora and the carved trail all agree automatically:
//   h = natural + D(s)·W(lat)       D = Y − natural height on the centre line. W = 1 on the core, (1−t)² across the flanks
//                                   (t = 0..1 over a width 2|D|/kMax): where the line runs above the hillside it stands up
//                                   as a ridge (the spine), where it cuts below it sinks into a gully (the couloir), with the
//                                   flanks steepest (kMax) right beside the line.
//   h = lerp(h, Y, flat)            riding surfaces (crest, slabs, lips, landings) are clean planes, not noise.
//   h += band(s + jitter)·taper     cliff drops and the canyon gap are "bands": exact long profiles across a limited width
//                                   (a cliff band with ragged ends, a slot canyon that pinches out), built from ballistics.
// Ballistics, in this game's physics: takeoff horizontal speed u, vertical u·(lip slope); g = 9.81; air drag 0.003·v² since 2026-10-06 (2.5 %/s when these were designed — ~2 % shorter flights now);
// a landing crashes when the normal impact speed vn > 10 m/s with assist (8.5 without), bottoms out above 6 (game.js's
// two-tyre model, 2026-10-06). That model also means a lip must be CRISP — a near-vertical edge right after it — or the
// body rides down a rounded edge on its rear tyre and leaves nose-down with the vertical speed gone.
// A straight landing below a drop can't serve a range of speeds: the faster you go, the further you fly and the more
// you fall, so vn grows with u (a 45° plane below a 6 m cliff: vn 8 at 6 m/s, 19 at 14 m/s = overshoot). A PROGRESSIVE
// landing that steepens with distance, like a ski-jump hill, keeps vn almost constant: the further you fly, the steeper
// the ground you meet. Numbers below come from tools/rz_design.mjs (same integration as the game; checked in-game by
// tools/rz_launch.mjs, which fires the real bike off each feature).
export const RZ = { on: false, bands: [], T: null, feats: [] };
const RZ_OFF = { fix: 0, edge: 0, rk: 0, air: 0, lip: 0 };   // trail flags for Razorback's ordinary (alternative) trails
const RZ_RES = 4, RZ_END = 2950, RZ_N = RZ_END * RZ_RES + 1, RZ_PRE = 6;
// The line, top to bottom. s in metres down the fall line; g = grade along the line (descent per metre, tan of the angle).
//  summit  raised flat summit block, D0 m above the hillside       slab   planar granite ridden straight down
//  spine   knife-edge crest: ~2.6 m of tread, flanks to ~67°       run    explicit grade, sets the speed for what follows
//  chute   walled couloir                                          huck   roll-off lip → cliff face → progressive landing
//  gap     kicker → slot canyon → far rim → progressive landing    (between sections the line follows the hillside)
// huck/gap fields: gin run-in grade · t0 lip slope (dy/dx, + = up) · H/fw cliff face height/width · G gap length ·
//  depth slot depth · R far rim below the lip · b0→b1 landing angle (°) steepening over Lb m, then b1 for Ls m, then
//  eased over Lt m to the run-out grade gout · K knuckle rounding (m) · ext [left, right] half-width of the band (m).
// Plans per corridor mountain: base = the centre line's long bends [a1, k1, φ1, a2, k2, φ2] (x = a·sin(k·s + φ)),
// wig = amplitude (m) of the small swings between features, plan = the sections.
const RZ_PLANS = {};
RZ_PLANS.razorback = { base: [38, .0042, .6, 14, .011, 2], wig: 7, plan: [
  { k: 'summit', s0: 0, s1: 36, g: .08, D0: 24 },
  { k: 'slab', s0: 40, s1: 98, g: .8, name: 'Summit Slab' },                 // 38.7° granite roll-in off the summit
  { k: 'run', s0: 98, s1: 112, g: .42 },
  { k: 'spine', s0: 112, s1: 450, g: .38, name: 'The Razorback' },           // 21° crest, 340 m long, rollers ±0.5 m
  { k: 'run', s0: 450, s1: 464, g: .38 },
  // Guillotine — the spine ends in a cliff. Lip rolls over to 24°; 6 m face; landing 40°→50° over 42 m, 12 m at 50°.
  //  In game: vn 6.1–6.6 m/s for lip speeds 14–18 m/s (a bottom-out, well under the crash line); at 17 m/s: 27 m out,
  //  29 m down, 1.6 s of air. Overshoot onto the run-out above ~22.5 m/s at the lip.
  { k: 'huck', s0: 464, lip: 470, name: 'Guillotine', gin: .38, t0: -.45, H: 6, fw: 2.5, b0: 40, b1: 50, K: .5, Lb: 42, Ls: 12, Lt: 26, gout: .45, ext: [36, 44], skew: -.12 },
  { k: 'chute', s0: 640, s1: 750, g: .84, name: 'The Couloir' },             // 40° between granite walls
  { k: 'run', s0: 990, s1: 1054, g: .42 },
  // The Slot — kicker to +8.5° with a 2 m straight lip, a 16 m slot canyon 22 m deep, far rim 4 m below the lip, landing
  //  28°→48° over 45 m. In game: clean from ~15 m/s at the lip (vn 3.7–4.9, 22–40 m of flight, 1.5–2.3 s of air); at
  //  12.8 m/s and below it cases the far rim. Overshoot above ~21 m/s.
  { k: 'gap', s0: 1054, lip: 1060, name: 'The Slot', gin: .42, t0: .15, G: 16, depth: 22, R: 4, b0: 28, b1: 48, K: 3, Lb: 45, Ls: 15, Lt: 26, gout: .45, ext: [70, 80], skew: .3 },
  { k: 'run', s0: 1440, s1: 1494, g: .30 },
  // Cathedral — bigger: lip rolls to 27°, 10 m face; landing 42°→52° over 40 m. In game: vn 7.0–7.7 (a hard bottom-out,
  //  survivable even without assist) for lip speeds 13–18 m/s; at 17 m/s: 36 m out, 44 m down, 2.2 s of air. Overshoot
  //  above ~20.5 m/s, so the 30% run-in matters: come in hot and you fly past the steep face.
  { k: 'huck', s0: 1494, lip: 1500, name: 'Cathedral', gin: .30, t0: -.5, H: 10, fw: 3, b0: 42, b1: 52, K: .5, Lb: 40, Ls: 12, Lt: 28, gout: .45, ext: [50, 42], skew: .15 },
  // The Berms — linked S-turns swinging ±11 m across a 23° path grade: turn radius ≈ 21 m, banked to 23° by the trail's
  //  berms, which hold ≈ 18 m/s (lateral grip μg·(1 + 0.6·bank) plus the bank's own lean); faster washes out wide.
  { k: 'turns', s0: 1610, s1: 1850, g: .42, A: 11, lam: 95, name: 'The Berms' },
  { k: 'slab', s0: 1885, s1: 1962, g: .9, name: 'Mirror Slab' },             // 42° polished slab — the one bare-rock run
  // Fall Line — 38° straight down through the larches, then a flat bench: the compression at the bottom loads the
  //  bike at v²·κ ≈ 2 g at 18 m/s (the bench rounds the 0.78 → 0.15 change over ~16 m).
  { k: 'plunge', s0: 2180, s1: 2320, g: .78, name: 'Fall Line' },
  { k: 'run', s0: 2320, s1: 2345, g: .15 },
] };
// Hollowfell. Grades are along the path. Jumps are built dirt: kicker (narrow), a natural gap between steep dirt faces, a
// built landing whose face steepens with distance (same progressive idea as Razorback's drops, see rz_design.mjs).
RZ_PLANS.hollowfell = { base: [44, .0037, 1.9, 16, .0105, .4], wig: 9, plan: [
  { k: 'summit', s0: 0, s1: 36, g: .08, D0: 6 },
  { k: 'run', s0: 40, s1: 110, g: .4 },
  // Heather Berms — fast open moor: ±15 m swings, radius ≈ 38 m, banked: carries 20+ m/s
  { k: 'turns', s0: 110, s1: 330, g: .33, A: 15, lam: 150, name: 'Heather Berms' },
  { k: 'run', s0: 330, s1: 394, g: .30 },
  { k: 'jump', s0: 394, lip: 400, name: 'The Big Double', gin: .30, t0: .2, G: 20, depth: 2.6, fg: .30, wn: .8, wf: 3, R: 5, b0: 22, b1: 36, K: 3, Lb: 30, Ls: 6, Lt: 18, gout: .32, ext: [3.4, 3.4], tap: 3.5, en: 0, jit: 0, rk: 0 },
  { k: 'run', s0: 480, s1: 554, g: .32 },
  { k: 'jump', s0: 554, lip: 560, name: 'Tabletop', gin: .32, t0: .25, G: 12, depth: .3, fg: .05, wn: .6, wf: .6, R: 1, b0: 20, b1: 37, K: 2, Lb: 34, Ls: 10, Lt: 18, gout: .34, ext: [3.6, 3.6], tap: 3.5, en: 0, jit: 0, rk: 0 },
  { k: 'run', s0: 625, s1: 694, g: .36 },
  { k: 'huck', s0: 694, lip: 700, name: 'Moor Drop', gin: .36, t0: -.3, H: 4, fw: 2, b0: 32, b1: 42, K: .5, Lb: 32, Ls: 8, Lt: 22, gout: .45, ext: [9, 11], tap: 12, en: 4, jit: .3, rk: 0 },
  // each forest chute is entered over a 0.5-grade roll-in, so a rider at 17 m/s stays (just) on the ground over the
  // crest (v²κ ≈ 0.5 g) instead of launching off it and landing at the bottom
  { k: 'run', s0: 778, s1: 800, g: .5 },
  { k: 'plunge', s0: 800, s1: 930, g: .72, km: .8, roots: .5, name: 'Into the Dark' },     // 36° into the trees
  { k: 'run', s0: 930, s1: 950, g: .12 },                                                  // compression
  { k: 'traverse', s0: 985, s1: 1105, g: .26, A: -45, cam: .22, name: 'Off-Camber' },
  { k: 'turns', s0: 1135, s1: 1390, g: .28, A: 11, lam: 85, name: 'Switchbacks' },         // R ≈ 17 m, 1.8 m catch berms (slope ≈ 0.6)
  { k: 'run', s0: 1408, s1: 1430, g: .5 },
  { k: 'plunge', s0: 1430, s1: 1570, g: .8, km: .8, roots: .8, name: 'Root Chute' },         // 38.7°
  { k: 'run', s0: 1570, s1: 1590, g: .12 },
  { k: 'traverse', s0: 1625, s1: 1745, g: .26, A: 40, cam: .22 },
  { k: 'run', s0: 1783, s1: 1805, g: .5 },
  { k: 'plunge', s0: 1805, s1: 1935, g: .76, km: .8, roots: .5, name: 'Black Chute' },
  { k: 'run', s0: 1935, s1: 1955, g: .15 },
  { k: 'turns', s0: 2000, s1: 2250, g: .48, A: 10, lam: 90, name: 'Steep Berms' },
  { k: 'run', s0: 2280, s1: 2314, g: .42 },
  { k: 'huck', s0: 2314, lip: 2320, name: 'Root Drop', gin: .42, t0: -.32, H: 3, fw: 1.5, b0: 30, b1: 40, K: .5, Lb: 26, Ls: 6, Lt: 20, gout: .45, ext: [6, 7], tap: 8, en: 3, jit: .2, rk: 0 },
  { k: 'run', s0: 2418, s1: 2440, g: .5 },
  { k: 'plunge', s0: 2440, s1: 2560, g: .7, km: .8, roots: .6, name: 'Final Plunge' },
  { k: 'run', s0: 2560, s1: 2580, g: .1 },
] };
let RZC = null, RZP = [];   // the current mountain's corridor (set by setMountain)
const rzBand = f => f.k === 'huck' || f.k === 'gap' || f.k === 'jump';   // kinds built as exact bands
// zone of a huck/gap/jump along the path: [lip − RZ_PRE, end]
const rzLen = f => RZ_PRE + (f.k === 'huck' ? f.fw : f.G) + f.Lb + f.Ls + f.Lt;
const rzEndS = f => rzBand(f) ? f.lip - RZ_PRE + rzLen(f) * 1.05 : f.s1;
// 0..1: how strongly the line is held straight (features and their run-ins)
function rzStraight(s) { let w = 0; for (const f of RZP) { if (f.k === 'summit') continue; w = Math.max(w, smooth(f.s0 - 40, f.s0 - 5, s) * (1 - smooth(rzEndS(f) + 5, rzEndS(f) + 40, s))); } return w; }
const rzBase = s => { const b = RZC.base; return b[0] * Math.sin(s * b[1] + b[2]) + b[3] * Math.sin(s * b[4] + b[5]); };
// turns swing the line side to side; a traverse carries it A metres across the hill (and it stays there)
function rzTurns(s) { let x = 0; for (const f of RZP) { if (f.k === 'turns' && s > f.s0 && s < f.s1) x += f.A * Math.sin((s - f.s0) * 2 * Math.PI / f.lam) * smooth(f.s0, f.s0 + 25, s) * (1 - smooth(f.s1 - 25, f.s1, s)); else if (f.k === 'traverse' && s > f.s0) x += f.A * smooth(f.s0, f.s1, s); } return x; }
function rzX0(s) { return rzBase(s) - rzBase(0) * (1 - smooth(0, 160, s)) + RZC.wig * Math.sin(s * .04 + 1.3) * (1 - rzStraight(s)) * smooth(120, 220, s) + rzTurns(s); }
// centre line x at depth s; it bends gently (R > 400 m) through the features and swings through berms between them,
// and ends on the finish
export function rzX(s) { const fin = Math.round(Math.round(rzX0(2600)) * .4); return lerp(rzX0(s), fin, smooth(2600, 2885, s)); }
function rzAlloc() { const A = () => new Float64Array(RZ_N); return { cx: A(), cc: A(), Y: A(), D: A(), wc: A(), km: A(), fa: A(), fw: A(), cv: A(), rk: A(), edge: A(), fix: A(), air: A(), lip: A(), cam: A(), roots: A(), dz: A() }; }
// exact long profile of a huck or gap along the path, from RZ_PRE m before the lip: heights (m) at 1/RZ_RES m steps
function rzProfile(f) {
  const n = Math.round(rzLen(f) * RZ_RES), E = new Float64Array(n + 1), nar = new Float64Array(n + 1), D2R = Math.PI / 180;
  const land = f.k === 'huck' ? f.fw : f.G, K = f.K || .5;
  for (let i = 0; i < n; i++) {
    const x = (i + .5) / RZ_RES; let d;   // descent per metre over this step
    // lip roll / kicker: the transition, then a straight lip held at the takeoff angle t0 (the last 1.5–2 m), so the
    // bike leaves at t0 rather than at whatever the curve happens to be doing at the edge
    if (x < RZ_PRE) d = f.k === 'huck' ? f.gin + (-f.t0 - f.gin) * smooth(RZ_PRE - 5, RZ_PRE - 1.5, x) : f.gin + (-f.t0 - f.gin) * smooth(0, 4, x);
    // gap: near wall (wn m), floor (falling fg per m: 0 = a level slot, = the run-in grade for a double's natural gap,
    // ≈ lip level for a tabletop's deck), far wall (wf m) up to the landing knuckle R below the lip
    else if (x < RZ_PRE + land) { const a = x - RZ_PRE, wn = f.wn ?? 1.5, wf = f.wf ?? 2, fg = f.fg ?? 0; d = f.k === 'huck' ? f.H / f.fw : a < wn ? f.depth / wn : a < f.G - wf ? fg : -(f.depth + fg * (f.G - wn - wf) - f.R) / wf; }
    else {
      const a = x - RZ_PRE - land; let b;
      if (a < K) b = f.b0 * a / K; else if (a < f.Lb) b = f.b0 + (f.b1 - f.b0) * (a - K) / (f.Lb - K); else if (a < f.Lb + f.Ls) b = f.b1;
      else b = lerp(f.b1, Math.atan(f.gout) / D2R, smooth(0, 1, (a - f.Lb - f.Ls) / f.Lt));
      d = Math.tan(b * D2R);
    }
    E[i + 1] = E[i] - d / RZ_RES;
    if (f.k !== 'huck' && x < RZ_PRE) nar[i + 1] = nar[i] + (f.gin - d) / RZ_RES;   // the kicker's bump over the run-in line
  }
  if (f.k !== 'huck') {   // the kicker is a narrow built ramp; its bump fades out down the near wall of the slot
    const i6 = Math.round(RZ_PRE * RZ_RES), k6 = nar[i6];
    for (let i = i6 + 1; i <= n; i++) nar[i] = k6 * Math.max(0, 1 - (i - i6) / RZ_RES / (f.wn ?? 1.5));
  }
  return { E, nar, n, airA: RZ_PRE, airB: RZ_PRE + land + K };
}
function buildCorridor() {
  RZ.on = false; RZ.bands = []; RZ.feats = [];
  if (!MOUNTAIN.corridor) return;
  const T = RZ.T || (RZ.T = rzAlloc()), N = RZ_N, R = RZ_RES;
  for (let i = 0; i < N; i++) T.cx[i] = rzX(i / R);
  for (let i = 0; i < N; i++) { const a = Math.max(0, i - 4), b = Math.min(N - 1, i + 4), d = (T.cx[b] - T.cx[a]) * R / (b - a); T.cc[i] = 1 / Math.sqrt(1 + d * d); }
  // the natural ground along the line (and a ±40 m smoothed copy to steer by)
  const Yn = new Float64Array(N), Ys = new Float64Array(N), P = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) { const x = T.cx[i], z = -i / R; Yn[i] = rawHeight(x, z, padClear(x, z)); P[i + 1] = P[i] + Yn[i]; }
  for (let i = 0; i < N; i++) { const a = Math.max(0, i - 160), b = Math.min(N - 1, i + 160); Ys[i] = (P[b + 1] - P[a]) / (b - a + 1); }
  // paint the plan: grade (NaN = follow the hillside), lateral shape and trail flags
  const G = new Float64Array(N).fill(NaN), EX = new Uint8Array(N);
  T.wc.fill(6); T.km.fill(1); T.fa.fill(0); T.fw.fill(8); T.cv.fill(0); T.rk.fill(0); T.edge.fill(0); T.fix.fill(0); T.air.fill(0); T.lip.fill(0); T.cam.fill(0); T.roots.fill(0); T.dz.fill(0);
  const idx = s => clamp(Math.round(s * R), 0, N - 1);
  const paint = (s0, s1, fn) => { for (let i = idx(s0); i <= idx(s1); i++) fn(i, i / R); };
  for (const f of RZP) {
    if (rzBand(f)) {
      const pr = rzProfile(f), i0 = idx(f.lip - RZ_PRE), cc = T.cc[idx(f.lip)], dLen = pr.n / R * cc;   // depth span of the zone
      const i1 = idx(f.lip - RZ_PRE + dLen), Etot = pr.E[pr.n], wide = new Float64Array(i1 - i0 + 1), nar = new Float64Array(i1 - i0 + 1);
      for (let i = i0; i <= i1; i++) {
        const xp = (i - i0) / R / cc * R, j = Math.min(pr.n - 1, Math.floor(xp)), u = Math.min(1, xp - j);
        const e = lerp(pr.E[j], pr.E[j + 1], u), q = lerp(pr.nar[j], pr.nar[j + 1], u), lin = Etot * (i - i0) / (i1 - i0);
        wide[i - i0] = e - q - lin; nar[i - i0] = q;
        G[i] = -Etot / ((i1 - i0) / R); EX[i] = 1;
        const xs = xp / R; T.wc[i] = 7; T.km[i] = 1.25; T.fa[i] = 1; T.fw[i] = 9; T.rk[i] = f.rk ?? .3; T.fix[i] = 1; if (f.rk === 0) T.dz[i] = 1;   // rocky lips (dirt jumps: rk 0); faces are rock by steepness
        // air 1: lip, face, slot — no tread, no trail dirt. air .5: the kicker / lip roll — exact ground (a 1 m tread
        // polyline would flatten the lip angle: its chord across the kicker's last metre is ~half the lip slope), dirt kept
        T.air[i] = xs > pr.airA - .2 && xs < pr.airB ? 1 : xs < pr.airA ? .5 : 0;
        if (Math.abs(xs - RZ_PRE) < .6 / R) T.lip[i] = f.k === 'huck' ? f.H : f.depth;
      }
      // tap: width (m) over which the band fades out sideways; en: noise on that edge; jit: ragged-rim amount (0 for built jumps)
      RZ.bands.push({ id: RZ.bands.length + 1, skew: f.skew || 0, f, s0: i0 / R, n: i1 - i0 + 1, w: wide, nw: nar, extL: f.ext[0], extR: f.ext[1], gap: f.k !== 'huck', tap: f.tap ?? 40, en: f.en ?? 14, jit: f.jit ?? 1 });
      RZ.feats.push({ name: f.name, k: f.k, lip: f.lip, x: T.cx[idx(f.lip)], end: i1 / R });
      continue;
    }
    paint(f.s0, f.s1, (i, s) => {
      const cc = T.cc[i];
      if (f.k === 'spine') G[i] = (f.g + .1 * Math.sin((s - f.s0) * 2 * Math.PI / 30) * smooth(f.s0, f.s0 + 30, s) * (1 - smooth(f.s1 - 30, f.s1, s))) / cc;
      else G[i] = f.g / cc;
      T.fix[i] = f.k === 'summit' || f.k === 'turns' || f.k === 'traverse' ? 0 : 1;
      if (f.roots) T.roots[i] = f.roots;
      if (f.k === 'traverse') { T.cam[i] = f.cam || 0; T.fa[i] = .25; T.fw[i] = 4; }
      if (f.k === 'summit') { T.wc[i] = 34; T.km[i] = 1.2; }
      else if (f.k === 'slab') { T.wc[i] = 10; T.km[i] = 1.4; T.fa[i] = 1; T.fw[i] = 8; T.cv[i] = -.003; T.rk[i] = 1; }
      else if (f.k === 'plunge') { T.wc[i] = 6; T.km[i] = f.km ?? 1.3; T.fa[i] = .6; T.fw[i] = 5; }       // dirt, the hillside's texture kept
      else if (f.k === 'spine') { T.wc[i] = 1.5; T.km[i] = 2.4; T.fa[i] = 1; T.fw[i] = .6; T.rk[i] = .55; T.edge[i] = 1; }   // granite crest
      else if (f.k === 'chute') { T.wc[i] = 5; T.km[i] = 2.2; T.fa[i] = .7; T.fw[i] = 3; T.rk[i] = .2; }                     // scree floor
    });
    if (f.name) RZ.feats.push({ name: f.name, k: f.k, s0: f.s0, s1: f.s1 });
  }
  // off-camber traverses: the tread tilts the way the hillside falls (up to cam), so the bike wants to slide off downhill
  for (let i = 0; i < N; i++) if (T.cam[i] > 0) { const x = T.cx[i], z = -i / R, gl = (rawHeight(x + 2, z, 0) - rawHeight(x - 2, z, 0)) / 4 / T.cc[i]; T.cam[i] = clamp(gl, -T.cam[i], T.cam[i]); }
  // integrate the profile. Pass 1: follow the plan; between sections steer D back toward 0 over ~90 m, grade 0.18–0.85.
  const Y = T.Y, g = new Float64Array(N), D0 = RZP[0].D0;
  Y[0] = Yn[0] + D0;
  for (let i = 0; i < N - 1; i++) {
    g[i] = G[i] === G[i] ? G[i] : clamp(-(Ys[i + 1] - Ys[i]) * R + (Y[i] - Ys[i]) / 90, .18, .85);
    Y[i + 1] = Y[i] - g[i] / R;
  }
  // pass 2: smooth the grade over ±8 m (convex roll-overs into the slabs and the couloir, no kinks), but leave the huck and
  // gap zones exact; next to them the smoothing sees their entry/exit grades so their run-ins and run-outs stay true
  const gs = new Float64Array(N), H8 = 8 * R;
  for (let i = 0; i < N; i++) {
    if (EX[i]) { gs[i] = g[i]; continue; }
    let a = 0, c = 0;
    for (let j = Math.max(0, i - H8); j <= Math.min(N - 2, i + H8); j++) {
      let v = g[j];
      if (EX[j]) { const b = RZ.bands.find(b => j >= b.s0 * R - 1 && j < b.s0 * R + b.n + 1); v = j < i ? b.f.gout : b.f.gin; }
      a += v; c++;
    }
    gs[i] = a / c;
  }
  for (let i = 0; i < N - 1; i++) Y[i + 1] = Y[i] - gs[i] / R;
  for (let i = 0; i < N; i++) T.D[i] = Y[i] - Yn[i];
  // ease the lateral shape along the line (±10 m) so the flanks never change abruptly
  for (const k of ['wc', 'km', 'fa', 'fw', 'rk', 'edge', 'cv']) { const A = T[k], B = Float64Array.from(A), W = 10 * R;
    for (let i = 0; i < N; i++) { let a = 0, c = 0; for (let j = Math.max(0, i - W); j <= Math.min(N - 1, i + W); j += 2) { a += B[j]; c++; } A[i] = a / c; } }
  { const B = Float64Array.from(T.fix), W = 6 * R; for (let i = 0; i < N; i++) { let m = B[i]; for (let j = Math.max(0, i - W); j <= Math.min(N - 1, i + W); j++) m = Math.max(m, B[j] * (1 - Math.abs(j - i) / W)); T.fix[i] = m; } }
  RZ.on = true;
}
// lateral position (m, + = right looking downhill... sign only matters for the band ends) and table lookups at depth s
function rzAt(x, z) {
  const T = RZ.T, s = -z; if (s > RZ_END - 1) return null;
  const f = Math.max(0, s) * RZ_RES, i = Math.min(RZ_N - 2, f | 0), u = f - i;
  const L = A => A[i] + (A[i + 1] - A[i]) * u;
  return { s, L, lat: (x - L(T.cx)) * L(T.cc), lw: s < 0 ? smooth(-90, 0, s) : 1 - smooth(RZ_END - 80, RZ_END - 1, s) };
}
function rzShape(x, z, h) {
  const q = rzAt(x, z); if (!q || q.lw <= 0) return h;
  const T = RZ.T, { L, lat, lw, s } = q, al = Math.abs(lat);
  // flanks: wander in and out along the line (never on the knife-edge itself) so ridges and gullies read as rock, not
  // embankments; crags and buttresses on the flank faces scale with their height
  const D = L(T.D) * lw, ed = L(T.edge), sd = lat < 0 ? 7.3 : 2.1, wob = 1 - ed * .85;
  const wc = L(T.wc) + wob * (4 * noise2(s * .035, sd) + 1.5 * noise2(s * .13, sd + 4)) * smooth(2, 6, L(T.wc));
  const len = Math.max(8, 2 * Math.abs(D) / L(T.km)) * (1 + .5 * wob * noise2(s * .022 + 3, sd + 9)), t = clamp((al - Math.max(0, wc)) / len, 0, 1);
  h += D * (1 - t) * (1 - t);
  if (t > 0 && t < 1) h += Math.abs(D) * t * (1 - t) * (.5 * noise2(x * .085 + 5, z * .085) + .25 * noise2(x * .21, z * .21 + 3));
  const fa = L(T.fa) * lw; if (fa > 0) { const k = fa * (1 - smooth(wc, wc + L(T.fw), al)); if (k > 0) h = lerp(h, L(T.Y) + L(T.cv) * lat * lat, k); }
  for (const b of RZ.bands) {
    const ds = s - b.s0; if (ds < -45 || ds > b.n / RZ_RES + 45) continue;
    // away from the riding line (exact within ±3.5 m) the rim wanders and runs off diagonally: a sinuous slot, a ragged band
    const jit = (9 * noise2(lat * .028 + b.id * 13.1, b.id * 2.3) + 2 * noise2(lat * .15, b.id * 5.7) + b.skew * lat) * smooth(3.5, 26, al) * b.jit;
    const e = (ds + jit) * RZ_RES; if (e < 0 || e >= b.n - 1) continue;
    const j = e | 0, v = e - j, ext = lat < 0 ? b.extL : b.extR;
    const tw = 1 - smooth(ext, ext + b.tap, al + b.en * noise2(s * .03 + b.id * 5.3, lat > 0 ? 3.7 : 9.1));
    if (tw > 0) h += (b.w[j] + (b.w[j + 1] - b.w[j]) * v) * tw;
    if (b.gap && al < 4.2) h += (b.nw[j] + (b.nw[j + 1] - b.nw[j]) * v) * (1 - smooth(2.6, 4.2, al));
  }
  return h;
}
// the main line as 1 m steps along the centre line, start to finish, each carrying its trail flags from the tables:
// fix (tread = exact ground, no smoothing), edge (tight blend: the knife-edge), rk (bare rock tread), air (no tread at all:
// lips, faces and the slot keep the exact analytic ground), lip (a drop: braking bumps before it)
function rzPath() {
  const T = RZ.T, out = []; let s = 18, ip = 0;
  while (s < 2900) {
    const f = s * RZ_RES, i = Math.min(RZ_N - 2, f | 0), u = f - i, L = A => A[i] + (A[i + 1] - A[i]) * u;
    let lip = 0; for (let j = ip; j <= i + 1; j++) lip = Math.max(lip, T.lip[j]); ip = i + 2;
    out.push({ x: L(T.cx), z: -s, rz: { fix: L(T.fix), edge: L(T.edge), rk: L(T.rk), air: Math.max(T.air[i], T.air[i + 1]), lip, cam: L(T.cam), roots: L(T.roots) } });
    s += L(T.cc);
  }
  out.push({ x: FINISH.x, z: FINISH.z, rz: { fix: 0, edge: 0, rk: 0, air: 0, lip: 0 } });
  return out;
}
// built dirt (0..1): the kicker, decks, faces and landings of a 'jump', and a dirt huck's lip and landing
function rzDirt(x, z) { const q = rzAt(x, z); if (!q) return 0; const T = RZ.T, d = q.L(T.dz); return d > 0 ? d * (1 - smooth(5, 9, Math.abs(q.lat))) * q.lw : 0; }
// bare granite on Razorback's slabs, crest and lips (0..1)
function rzRock(x, z) { const q = rzAt(x, z); if (!q) return 0; const T = RZ.T, wc = q.L(T.wc); return q.L(T.rk) * (1 - smooth(wc + 2, wc + 7, Math.abs(q.lat))) * q.lw; }

// trail cross-section on Razorback's designed line: as trailAt, plus the knife-edge's tight blend, bare-rock treads (no ruts
// on granite) and "air" stretches (lip, face, slot) where the tread steps aside and the exact ground is ridden
function rzTrail({ T, a, b, u, lat }, x, z) {
  const w = T.w, al = Math.abs(lat), A = a.rz, B = b.rz, air = Math.max(A.air, B.air), edge = lerp(A.edge, B.edge, u), rk = lerp(A.rk, B.rk, u);
  const y = lerp(a.y, b.y, u), bank = lerp(a.bank, b.bank, u), berm = lerp(a.berm, b.berm, u), garden = lerp(a.garden, b.garden, u), roll = Math.max(a.roll, b.roll);
  let tread = y + bank * lat - .07 * Math.exp(-(((al - .32) / .11) ** 2)) * (1 - garden) * (1 - rk);
  if (garden > 0) tread += garden * (noise2(x * 2.7, z * 2.7) * .13 + noise2(x * 5.9, z * 5.9) * .06);   // roots and loam chatter, not boulders
  if (lat * bank > 0) tread += berm * smooth(w * .5, w + (T.bermW || 1), al);   // bermW: a wider, rideable catch-berm wall
  const m = air > .25 ? 0 : lerp(1 - smooth(w + .5, w + 4.5, al), 1 - smooth(w + .15, w + 1.1, al), edge);
  // Razorback has no rock gardens or rock rolls: its "gardens" are root-and-loam chatter, its rolls steep dirt
  return { tread, m, lat, w, dirt: air > .75 ? 0 : (1 - smooth(w - .1, w + .7, al)) * (1 - rk * .85), rock: rk * (1 - smooth(w, w + 1.5, al)) * (air > .75 ? 0 : 1), T };
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
  RZC = MOUNTAIN.corridor ? RZ_PLANS[MOUNTAIN.corridor] : null; RZP = RZC ? RZC.plan : [];
  OX = MOUNTAIN.seed * 1013.7; OZ = MOUNTAIN.seed * -733.1;
  buildCourse(); STRUCTS.length = 0; LINES.length = 0; SB.clear(); LB.clear(); TRAILS.length = 0; TB.clear();
  buildCorridor();
  START_H = rawHeight(START.x, START.z, 1);
  buildTrails();
  buildStructures();
  buildBalance();
  return MOUNTAIN;
}
setMountain('ridgeline');
