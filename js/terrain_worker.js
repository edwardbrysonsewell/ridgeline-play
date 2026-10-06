// terrain_worker.js — builds terrain tile geometry from terrainfn.js. Pure JS (no three.js).
// Used two ways: as a module Worker and imported directly by terrain.js as a main-thread fallback (buildTileData).
// Messages in:  {mtn}                      switch mountain (terrainfn.setMountain)
//               {id,i,j,lod,mtn,tol}       build a tile (tol: LOD-0 height tolerance, m) (mtn checked too, so a stray request can never use the wrong world)
// Messages out: {id,i,j,lod,pos,nor,aS,aM,aX,idx,ymin,ymax,nv,ms} with transferable typed arrays.
//
// LOD 0  adaptive and anisotropic: the tile is split into 16×16 blocks of 4 m; each block picks an x spacing and a
//        z spacing from {2, 1, ½, ¼, ⅛ m} from the measured curvature of heightAt along that axis, so a cliff band
//        that runs across the slope gets ⅛ m rows down the fall line without paying for ⅛ m columns. Spacings are
//        nested (powers of two), and vertices on an edge shared with a coarser block are snapped onto the coarse
//        edge, so there are no T-junctions inside a tile.
// LOD 1–3 uniform grids of 1.33 / 4 / 8 m (surface weights sampled at fine scale so cliffs stay rock).
// Every tile gets skirts on its four borders, which hide cracks against neighbours at another LOD.
// Per-vertex data: position (tile-local), normal (int8), aS = surface weights [dirt,grass,forest,rock],
//   aM = [ambient occlusion, aspen share, feature core (packed dirt), forest density],
//   aX = [talus (scree fan below a cliff), hollow (concavity at ~8 m: snow / sand washes / puddles), trail heading, braking bumps],
//   aT = [trail lateral position (half-widths/16+½), tread dirt, uphill cut bank, berm wall]   (all uint8)
import {MOUNTAIN,setMountain,TILE,heightAt,surfaceInto,forFeatures,aspenAt,forestAt,smooth,clamp,TRAILS,trailAt} from './terrainfn.js';

// ── carved trails: nearest-point index per trail (4 m buckets) and per-point braking-bump strength, rebuilt per mountain
let TI = null;
function trailIndex() {
  if (TI && TI.mtn === MOUNTAIN.id && TI.n === TRAILS.length && TI.first === TRAILS[0]) return TI;
  TI = { mtn: MOUNTAIN.id, n: TRAILS.length, first: TRAILS[0], grid: new Map(), brk: new Map() };
  for (const T of TRAILS) {
    const pts = T.pts, n = pts.length, g = new Map(), brk = new Float32Array(n);
    for (let i = 0; i < n; i++) { const k = Math.floor(pts[i].x / 4) * 100000 + Math.floor(pts[i].z / 4); let a = g.get(k); if (!a) g.set(k, a = []); a.push(i); }
    const ang = (i, j) => { const a = pts[clamp(i, 0, n - 1)], b = pts[clamp(j, 0, n - 1)]; return Math.acos(clamp(a.tx * b.tx + a.tz * b.tz, -1, 1)); };
    for (let i = 0; i < n; i++) {
      let m = 0; for (let a = 6; a <= 24; a += 3) m = Math.max(m, ang(i + a - 6, i + a));
      let b = smooth(.12, .4, m) * (1 - .75 * smooth(.08, .3, ang(i - 4, i + 4)));     // before a turn, not in it
      for (let a = 3; a <= 16; a++) { const q = pts[i + a]; if (q && (q.drop || q.roll)) { b = Math.max(b, .75 * (1 - a / 18)); break; } }
      brk[i] = b;
    }
    TI.grid.set(T, g); TI.brk.set(T, brk);
  }
  return TI;
}
// → null, or {lat (in half-widths), dirt, m, cut (uphill bench wall), berm, brake, tx, tz}
function trailInfo(x, z, h) {
  if (!TRAILS.length) return null;
  const t = trailAt(x, z); if (!t) return null;
  const ix = trailIndex(), g = ix.grid.get(t.T), pts = t.T.pts;
  let bi = -1, bd = 1e9; const cx = Math.floor(x / 4), cz = Math.floor(z / 4);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = g.get((cx + a) * 100000 + cz + b); if (l) for (const i of l) { const d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2; if (d < bd) { bd = d; bi = i; } } }
  const p = bi >= 0 ? pts[bi] : null, al = Math.abs(t.lat);
  const berm = p && p.berm > 0 && t.lat * p.bank > 0 ? Math.min(1, p.berm) * smooth(t.w * .5, t.w + .8, al) * (1 - smooth(t.w + 1.2, t.w + 2.5, al)) : 0;
  const cut = t.m > .02 ? clamp((h - t.tread) / 1.1, 0, 1) * smooth(t.w * .9, t.w + .6, al) * t.m * (1 - berm) : 0;
  return { lat: t.lat / t.w, dirt: t.dirt, m: t.m, cut, berm, brake: p ? ix.brk.get(t.T)[bi] : 0, tx: p ? p.tx : 0, tz: p ? p.tz : -1 };
}
const encAng = (tx, tz) => (Math.atan2(tx, -tz) / (2 * Math.PI) + .5);

const Q = 8;                 // lattice units per metre (⅛ m)
const NQ = TILE * Q;         // 512
const AP = 2 * Q;            // apron in lattice units (2 m)
const TOL = .03;             // target height error at LOD 0 (m)
const W = NQ + 1 + 2 * AP;   // cached lattice width
const UNI = [0, 48, 16, 8];  // cells per side for LOD 1..3
const SKIRT = [1.5, 4, 9, 18];
const OPTS = [16, 8, 4, 2, 1];   // spacings in lattice units: 2, 1, ½, ¼, ⅛ m (nested)

// talus and hollows on a coarse 2 m lattice (only where the mountain uses them)
function extrasGrid(x0, z0, step, n) {
  const bio = MOUNTAIN.biome || MOUNTAIN.id, wantT = bio === 'widowmaker' || bio === 'desert' || bio === 'alpine', wantH = bio !== 'ridgeline';
  const G = new Float32Array((n + 1) * (n + 1) * 2);
  if (!wantT && !wantH) return G;
  const gr = MOUNTAIN.grade;
  for (let a = 0; a <= n; a++) for (let b = 0; b <= n; b++) {
    const x = x0 + b * step, z = z0 + a * step, h = heightAt(x, z), k = (a * (n + 1) + b) * 2;
    if (wantT) {   // a cliff or ledge uphill (+z) within ~20 m sheds a scree fan onto this point
      let t = 0;
      for (const d of [3, 7, 12, 19]) { const rise = heightAt(x, z + d) - h - gr * d; t = Math.max(t, clamp((rise - 1.2) / 3, 0, 1) * (1 - smooth(6, 24, d) * .75)); }
      G[k] = t;
    }
    if (wantH) {
      const r = 7, m = (heightAt(x + r, z) + heightAt(x - r, z) + heightAt(x, z + r) + heightAt(x, z - r)) * .25 - h;
      G[k + 1] = clamp(m / .9, 0, 1);
    }
  }
  return G;
}

export function buildTileData(i, j, lod) {
  const x0 = i * TILE, z0 = j * TILE;
  const P = [], N = [], S = [], M = [], X = [], TT = [];
  let nv = 0, ymin = 1e9, ymax = -1e9;
  const wtmp = [0, 0, 0, 0];
  const NOT = [255, 0, 0, 0], NOX = [128, 0];
  const pushV = (lx, h, lz, nx, ny, nz, s4, m4, x2, t4 = NOT, x34 = NOX) => {
    P.push(lx, h, lz); N.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
    S.push(s4[0], s4[1], s4[2], s4[3]); M.push(m4[0], m4[1], m4[2], m4[3]); X.push(x2[0], x2[1], x34[0], x34[1]); TT.push(t4[0], t4[1], t4[2], t4[3]);
    if (h < ymin) ymin = h; if (h > ymax) ymax = h; return nv++;
  };
  const I = [];
  const fcore = (x, z) => { let c = 0; forFeatures(x, z, (f, u, v) => { if (u > -1 && u < f.len + 1) c = Math.max(c, 1 - smooth(f.W * .3, f.W * .85, Math.abs(v))); }); return c; };
  const enc = v => Math.round(clamp(v, 0, 1) * 255);
  const trailEnc = t => t ? [[enc(t.lat / 16 + .5), enc(t.dirt), enc(t.cut), enc(t.berm)], [enc(encAng(t.tx, t.tz)), enc(t.brake)]] : [NOT, NOX];
  // extras on a 2 m lattice (tile-aligned, so neighbouring tiles agree)
  const EG = [32, 16, 8, 4][lod], EGS = TILE / EG, EX = extrasGrid(x0, z0, EGS, EG);
  const extra = (lx, lz) => {
    const bx = Math.min(EG - 1, Math.floor(lx / EGS)), bz = Math.min(EG - 1, Math.floor(lz / EGS)), fx = lx / EGS - bx, fz = lz / EGS - bz;
    const k00 = (bz * (EG + 1) + bx) * 2, k10 = k00 + 2, k01 = k00 + (EG + 1) * 2, k11 = k01 + 2;
    const f = o => (EX[k00 + o] * (1 - fx) + EX[k10 + o] * fx) * (1 - fz) + (EX[k01 + o] * (1 - fx) + EX[k11 + o] * fx) * fz;
    return [enc(f(0)), enc(f(1))];
  };

  if (lod > 0) {
    // ── uniform grid with a one-cell apron for normals and AO
    const n = UNI[lod], st = TILE / n, R = n + 3;
    const H = new Float32Array(R * R);
    for (let a = 0; a < R; a++) for (let b = 0; b < R; b++) H[a * R + b] = heightAt(x0 + (b - 1) * st, z0 + (a - 1) * st);
    const vid = new Int32Array((n + 1) * (n + 1));
    for (let a = 0; a <= n; a++) for (let b = 0; b <= n; b++) {
      const k = (a + 1) * R + b + 1, h = H[k], x = x0 + b * st, z = z0 + a * st;
      let nx = -(H[k + 1] - H[k - 1]) / (2 * st), nz = -(H[k + R] - H[k - R]) / (2 * st); const l = Math.hypot(nx, 1, nz);
      // surface weights see the steepest fine slope around the vertex (cliff faces are far narrower than the grid)
      let fl = 1;
      for (const [dx, dz] of [[.6, 0], [0, .6], [0, -.6], [-.6, 0]]) { const g = (heightAt(x + dx, z + dz) - h) / .6; fl = Math.max(fl, Math.hypot(g, 1)); }
      if (lod === 1) { const g = Math.abs(H[k + R] - H[k - R]) / (2 * st); fl = Math.max(fl, Math.hypot(g * 1.5, 1)); }
      const lap = (H[k + 1] + H[k - 1] + H[k + R] + H[k - R]) * .25 - h;
      const ao = clamp(1 - Math.max(0, lap) * (lod === 1 ? .9 : .35), .55, 1);
      const fo = forestAt(x, z);
      surfaceInto(x, z, 1 / fl, wtmp);
      vid[a * (n + 1) + b] = pushV(b * st, h, a * st, nx / l, 1 / l, nz / l, [enc(wtmp[0]), enc(wtmp[1]), enc(wtmp[2]), enc(wtmp[3])],
        [enc(ao * (1 - .12 * fo)), enc(aspenAt(x, z)), enc(lod === 1 ? fcore(x, z) : 0), enc(fo)], extra(b * st, a * st), ...trailEnc(lod < 3 ? trailInfo(x, z, h) : null));
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const p = vid[a * (n + 1) + b], q = vid[a * (n + 1) + b + 1], r = vid[(a + 1) * (n + 1) + b], s = vid[(a + 1) * (n + 1) + b + 1];
      // split each quad along the diagonal that follows the surface better (keeps cliff lips straight)
      if (Math.abs(P[p * 3 + 1] - P[s * 3 + 1]) <= Math.abs(P[q * 3 + 1] - P[r * 3 + 1])) I.push(p, r, s, p, s, q); else I.push(p, r, q, q, r, s);
    }
    const rows = []; for (let t = 0; t <= n; t++) rows.push(t);
    const edge = list => list.map(([a, b]) => vid[a * (n + 1) + b]);
    skirtFor(edge(rows.map(t => [0, t]))); skirtFor(edge(rows.map(t => [n, t])));
    skirtFor(edge(rows.map(t => [t, 0]))); skirtFor(edge(rows.map(t => [t, n])));
  } else {
    const HC = new Float32Array(W * W).fill(NaN);
    const Hq = (ix, iz) => { const k = (iz + AP) * W + ix + AP; let h = HC[k]; if (h !== h) { h = HC[k] = heightAt(x0 + ix / Q, z0 + iz / Q); } return h; };
    let anyTrail = false;
    // 1 m lattice: surface weights (normal from the steepest ½ m slope), AO, aspen, feature core, forest
    const L = TILE + 1, LS = 15, LA = new Float32Array(L * L * LS);
    for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) {
      const ix = b * Q, iz = a * Q, h = Hq(ix, iz), x = x0 + b, z = z0 + a, e = Q >> 1;
      const gx = Math.max(Math.abs(Hq(ix + e, iz) - h), Math.abs(h - Hq(ix - e, iz))) * 2, gz = Math.max(Math.abs(Hq(ix, iz + e) - h), Math.abs(h - Hq(ix, iz - e))) * 2;
      const ny = 1 / Math.hypot(gx, 1, gz);
      const lap = (Hq(ix + 2 * Q, iz) + Hq(ix - 2 * Q, iz) + Hq(ix, iz + 2 * Q) + Hq(ix, iz - 2 * Q)) * .25 - h;
      const lap2 = (Hq(ix + Q, iz) + Hq(ix - Q, iz) + Hq(ix, iz + Q) + Hq(ix, iz - Q)) * .25 - h;
      const fo = forestAt(x, z);
      const k = (a * L + b) * LS;
      LA[k] = clamp(1 - Math.max(0, lap) * 1.1 - Math.max(0, lap2) * 1.5, .45, 1) * (1 - .12 * fo);
      surfaceInto(x, z, ny, wtmp); LA[k + 1] = wtmp[0]; LA[k + 2] = wtmp[1]; LA[k + 3] = wtmp[2]; LA[k + 4] = wtmp[3];
      LA[k + 5] = aspenAt(x, z); LA[k + 6] = fcore(x, z); LA[k + 7] = fo;
      const ti = trailInfo(x, z, h);
      if (ti) { LA[k + 8] = ti.lat; LA[k + 9] = ti.dirt; LA[k + 10] = ti.cut; LA[k + 11] = ti.berm; LA[k + 12] = ti.brake; LA[k + 13] = ti.tx; LA[k + 14] = ti.tz; anyTrail = true; }
      else { LA[k + 8] = 8; LA[k + 14] = -1; }
    }
    const latt = (lx, lz, o) => {
      const bx = Math.min(TILE - 1, Math.floor(lx)), bz = Math.min(TILE - 1, Math.floor(lz)), fx = lx - bx, fz = lz - bz;
      const k00 = (bz * L + bx) * LS + o, k10 = k00 + LS, k01 = k00 + L * LS, k11 = k01 + LS;
      return (LA[k00] * (1 - fx) + LA[k10] * fx) * (1 - fz) + (LA[k01] * (1 - fx) + LA[k11] * fx) * fz;
    };
    // per-block spacing per axis from the max |second difference| at ½ m and 1 m along that axis
    const NB = 16, BS = TILE / NB, BQ = BS * Q, SPX = new Int32Array(NB * NB), SPZ = new Int32Array(NB * NB);
    const tol = globalThis.__TOL || TOL; const pick = c => { const hmax = Math.sqrt(8 * tol / (c + .3)); for (const o of OPTS) if (o / Q <= hmax) return o; return OPTS[OPTS.length - 1]; };
    for (let bz = 0; bz < NB; bz++) for (let bx = 0; bx < NB; bx++) {
      let cx = 0, cz = 0; const e = Q >> 1;
      for (let a = bz * BS * 2; a <= (bz + 1) * BS * 2; a++) for (let b = bx * BS * 2; b <= (bx + 1) * BS * 2; b++) {
        const ix = b * e, iz = a * e, h2 = 2 * Hq(ix, iz);
        // curvature in m⁻¹ from ½ m second differences (Δ²h / ½²)
        cx = Math.max(cx, Math.abs(Hq(ix + e, iz) + Hq(ix - e, iz) - h2) * 4);
        cz = Math.max(cz, Math.abs(Hq(ix, iz + e) + Hq(ix, iz - e) - h2) * 4);
      }
      let sx = pick(cx), sz = pick(cz);
      if (anyTrail) {   // resolve the tread (ruts, berms, drop lips) at ¼ m or finer
        // ⅛ m across the tread (the axis the trail crosses), ¼ m along it
        let tr = 0, ax = 0, az = 0;
        for (let a = bz * BS; a <= (bz + 1) * BS; a++) for (let b = bx * BS; b <= (bx + 1) * BS; b++) { const k = (a * L + b) * LS; if (Math.abs(LA[k + 8]) < 2.2) { tr = 1; ax = Math.max(ax, Math.abs(LA[k + 14])); az = Math.max(az, Math.abs(LA[k + 13])); } }
        if (tr) { sx = Math.min(sx, ax > .45 ? 1 : 2); sz = Math.min(sz, az > .45 ? 1 : 2); }
      }
      SPX[bz * NB + bx] = sx; SPZ[bz * NB + bx] = sz;
    }
    const spx = (bx, bz) => (bx < 0 || bz < 0 || bx >= NB || bz >= NB) ? 0 : SPX[bz * NB + bx];
    const spz = (bx, bz) => (bx < 0 || bz < 0 || bx >= NB || bz >= NB) ? 0 : SPZ[bz * NB + bx];
    const VW = NQ + 1, vmap = new Int32Array(VW * VW).fill(-1);
    const vkey = [];
    for (let bz = 0; bz < NB; bz++) for (let bx = 0; bx < NB; bx++) {
      const sx = SPX[bz * NB + bx], sz = SPZ[bz * NB + bx], nx_ = BQ / sx, nz_ = BQ / sz, ox = bx * BQ, oz = bz * BQ;
      // edge spacing: the coarser of this block and its neighbour (along the edge's own axis)
      const eN = Math.max(sx, spx(bx, bz - 1)), eS = Math.max(sx, spx(bx, bz + 1)), eW = Math.max(sz, spz(bx - 1, bz)), eE = Math.max(sz, spz(bx + 1, bz));
      const vid = new Int32Array((nx_ + 1) * (nz_ + 1));
      for (let a = 0; a <= nz_; a++) for (let b = 0; b <= nx_; b++) {
        const ix = ox + b * sx, iz = oz + a * sz, key = iz * VW + ix;
        if (vmap[key] >= 0) { vid[a * (nx_ + 1) + b] = vmap[key]; continue; }
        let h = Hq(ix, iz);
        if (a === 0 && ix % eN) { const t0 = ix - ix % eN, f = (ix - t0) / eN; h = Hq(t0, iz) * (1 - f) + Hq(t0 + eN, iz) * f; }
        else if (a === nz_ && ix % eS) { const t0 = ix - ix % eS, f = (ix - t0) / eS; h = Hq(t0, iz) * (1 - f) + Hq(t0 + eS, iz) * f; }
        else if (b === 0 && iz % eW) { const t0 = iz - iz % eW, f = (iz - t0) / eW; h = Hq(ix, t0) * (1 - f) + Hq(ix, t0 + eW) * f; }
        else if (b === nx_ && iz % eE) { const t0 = iz - iz % eE, f = (iz - t0) / eE; h = Hq(ix, t0) * (1 - f) + Hq(ix, t0 + eE) * f; }
        const lx = ix / Q, lz = iz / Q;
        const v = pushV(lx, h, lz, 0, 1, 0, [enc(latt(lx, lz, 1)), enc(latt(lx, lz, 2)), enc(latt(lx, lz, 3)), enc(latt(lx, lz, 4))],
          [enc(latt(lx, lz, 0)), enc(latt(lx, lz, 5)), enc(latt(lx, lz, 6)), enc(latt(lx, lz, 7))], extra(lx, lz),
          ...(anyTrail ? [[enc(latt(lx, lz, 8) / 16 + .5), enc(latt(lx, lz, 9)), enc(latt(lx, lz, 10)), enc(latt(lx, lz, 11))], [enc(encAng(latt(lx, lz, 13), latt(lx, lz, 14))), enc(latt(lx, lz, 12))]] : [NOT, NOX]));
        vmap[key] = v; vkey.push(ix, iz); vid[a * (nx_ + 1) + b] = v;
      }
      for (let a = 0; a < nz_; a++) for (let b = 0; b < nx_; b++) {
        const p = vid[a * (nx_ + 1) + b], q = vid[a * (nx_ + 1) + b + 1], r = vid[(a + 1) * (nx_ + 1) + b], s = vid[(a + 1) * (nx_ + 1) + b + 1];
        if (Math.abs(P[p * 3 + 1] - P[s * 3 + 1]) <= Math.abs(P[q * 3 + 1] - P[r * 3 + 1])) I.push(p, r, s, p, s, q); else I.push(p, r, q, q, r, s);
      }
    }
    // normals: area-weighted face normals of the welded mesh; tile-border vertices use a fixed ½ m finite difference
    const acc = new Float32Array(nv * 3);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz; acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz; acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz;
    }
    const border = [[], [], [], []];
    for (let v = 0; v < nv; v++) {
      const ix = vkey[v * 2], iz = vkey[v * 2 + 1];
      let nx = acc[v * 3], ny = acc[v * 3 + 1], nz = acc[v * 3 + 2];
      if (ix === 0 || iz === 0 || ix === NQ || iz === NQ) {
        const e = Q >> 1; nx = -(Hq(ix + e, iz) - Hq(ix - e, iz)); nz = -(Hq(ix, iz + e) - Hq(ix, iz - e)); ny = 1;
        if (iz === 0) border[0].push([ix, v]); if (iz === NQ) border[1].push([ix, v]); if (ix === 0) border[2].push([iz, v]); if (ix === NQ) border[3].push([iz, v]);
      }
      const l = Math.hypot(nx, ny, nz) || 1; N[v * 3] = Math.round(nx / l * 127); N[v * 3 + 1] = Math.round(ny / l * 127); N[v * 3 + 2] = Math.round(nz / l * 127);
    }
    for (const b of border) skirtFor(b.sort((p, q) => p[0] - q[0]).map(p => p[1]));
  }
  function skirtFor(list) {
    const d = SKIRT[lod];
    const low = list.map(v => pushV(P[v * 3], P[v * 3 + 1] - d, P[v * 3 + 2], N[v * 3] / 127, N[v * 3 + 1] / 127, N[v * 3 + 2] / 127,
      [S[v * 4], S[v * 4 + 1], S[v * 4 + 2], S[v * 4 + 3]], [Math.round(M[v * 4] * .8), M[v * 4 + 1], M[v * 4 + 2], M[v * 4 + 3]], [X[v * 4], X[v * 4 + 1]], [TT[v * 4], TT[v * 4 + 1], TT[v * 4 + 2], TT[v * 4 + 3]], [X[v * 4 + 2], X[v * 4 + 3]]));
    for (let t = 0; t < list.length - 1; t++) { const a = list[t], b = list[t + 1], c = low[t], e = low[t + 1]; I.push(a, c, b, b, c, e, a, b, c, b, e, c); }
  }
  const pos = new Float32Array(P), nor = new Int8Array(N), aS = new Uint8Array(S), aM = new Uint8Array(M), aX = new Uint8Array(X), aT = new Uint8Array(TT);
  const idx = nv > 65535 ? new Uint32Array(I) : new Uint16Array(I);
  return { i, j, lod, mtn: MOUNTAIN.id, pos, nor, aS, aM, aX, aT, idx, ymin, ymax, nv };
}

// ── worker entry
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = e => {
    const { id, i, j, lod, mtn, tol } = e.data;
    if (tol) globalThis.__TOL = tol;
    if (mtn && mtn !== MOUNTAIN.id) setMountain(mtn);
    if (id === undefined) return;   // a pure mountain switch
    try {
      const t = performance.now(); const r = buildTileData(i, j, lod); r.id = id; r.ms = performance.now() - t;
      self.postMessage(r, [r.pos.buffer, r.nor.buffer, r.aS.buffer, r.aM.buffer, r.aX.buffer, r.aT.buffer, r.idx.buffer]);
    } catch (err) { self.postMessage({ id, error: String(err && err.stack || err) }); }
  };
}
