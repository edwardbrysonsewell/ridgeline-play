// structures.js — North Shore woodwork: raised boardwalks on stilts, ladder skinnies, drops off the end of decks.
// API used by game.js:
//   buildStructures() → Object3D for the current mountain's STRUCTS (terrainfn.js), added to the scene by game.js
//   disposeStructures(obj)
//   updateStructures(dt, now, camera)   every frame: near/far LOD and shadow casting per 64 m chunk
//
// Construction (as built on the Shore): posts → double bearers bolted either side of each post pair → 2–3 stringers
// → individual planks laid across with gaps, nailed over each stringer. Tall bents get X-bracing across and long
// diagonals along the line; low spans sit on log sleepers. Drops end in a painted lip plank and a header board.
// Skinnies are either a chainsawed split log or two lengthwise planks on a narrow frame.
//
// Rendering: one wood material over a 1024² atlas (tools/struct_tex.py). Geometry carries *unwrapped* uvs plus an
// atlas-region index; the fragment shader wraps inside the region (textureGrad keeps mips right), so long members
// need no extra vertices for texture repeats. Normal map B channel = roughness. Wetness, brightness and a
// procedural world-space moss amount ride on a per-vertex (or per-instance) byte attribute.
// Woodwork is cut into 64 m chunks: near = instanced planks + merged framing (+ chicken wire), casts shadows;
// far = a textured deck strip, posts and bracing in one merged mesh.
import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {STRUCTS,MOUNTAIN,heightAt,isMobile,START} from './core.js';

const CH = 64;                                         // chunk size (m)
const NEAR_D = isMobile ? 72 : 125, HYST = 10;          // near-detail radius from the camera (m)
const FAR_D = isMobile ? 750 : 1200;                   // beyond this, woodwork is sub-pixel / fogged out
const SHADOW_D = isMobile ? 80 : 150;                  // far chunks cast inside the shadow cascades only

// lumber (m)
const PL_T = .045, PL_W = .14, PL_PITCH = .162;        // 2x6 decking with ~2 cm gaps
const STR_W = .07, STR_H = .19;                        // stringers (2x8 on edge)
const BEAR_T = .045, BEAR_H = .19;                     // double bearers
const POST_R = .105;                                   // cedar posts (~21 cm)
const BR_W = .12, BR_T = .035;                         // bracing boards
const LOG_R = .38, LOG_C = .19;                        // skinny log: radius, axis depth below the flat top
const LOG_A = Math.sqrt(LOG_R * LOG_R - LOG_C * LOG_C);// half-width of the chainsawed top

// ───────────────────────── atlas regions (must match tools/struct_tex.py)
const REG = [];
function reg(px, py, w, h) { REG.push(new THREE.Vector4((px + .5) / 1024, 1 - (py + h - .5) / 1024, (w - 1) / 1024, (h - 1) / 1024)); return REG.length - 1; }
const R = { plank: [], lumber: [], post: [] };
for (let k = 0; k < 16; k++) R.plank.push(reg((k % 2) * 512, (k >> 1) * 64, 512, 64));
for (let k = 0; k < 4; k++) R.lumber.push(reg(0, 512 + 64 * k, 1024, 64));
for (let k = 0; k < 2; k++) R.post.push(reg(256 * k, 768, 256, 256));
R.bark = reg(512, 768, 256, 256); R.end = reg(768, 768, 128, 128); R.split = reg(768, 896, 128, 128);
R.far = reg(896, 768, 128, 128); R.moss = reg(896, 896, 128, 128);
const LIP = 15;
const BOLT = [36, 60, 0, 18];  // dark steel-ish sample of the algae lumber row (region 18)                                         // painted lip plank
const LUMBER_LEN = 2.8, POST_LEN = 1.4, FAR_LEN = .972; // metres covered by one texture repeat

// ───────────────────────── textures and materials
const TL = new THREE.TextureLoader();
function tex(url, srgb) { const t = TL.load(url); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = isMobile ? 2 : 4; return t; }
const TX = { a: tex('tex/struct/wood_a.jpg', true), n: tex('tex/struct/wood_n.jpg', false), w: tex('tex/struct/wire.png', true) };
TX.w.wrapS = TX.w.wrapT = THREE.RepeatWrapping;
const U = { uReg: { value: REG }, uWet: { value: .6 }, uMoss: { value: .6 } };
const NOISE = `
float stHash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float stNoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
 return mix(mix(stHash(i),stHash(i+vec2(1,0)),u.x),mix(stHash(i+vec2(0,1)),stHash(i+vec2(1,1)),u.x),u.y);}
float stFbm(vec2 p){return stNoise(p)*.5+stNoise(p*2.07+7.1)*.3+stNoise(p*4.13+3.7)*.2;}`;
const woodMat = new THREE.MeshStandardMaterial({ map: TX.a, normalMap: TX.n, roughness: 1, metalness: 0 });
woodMat.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, U);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec4 aInfo;
#ifdef USE_INSTANCING
attribute float aShade;
#endif
uniform vec4 uReg[${REG.length}];
varying vec4 vReg; varying vec3 vInf; varying vec3 vWP;`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>
 vReg = uReg[int(aInfo.w * 255. + .5)];
 float stB = aInfo.x * 2.;
#ifdef USE_INSTANCING
 stB *= aShade;
#endif
 vInf = vec3(stB, aInfo.y, aInfo.z);`)
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
 { vec4 stW = vec4(transformed, 1.);
#ifdef USE_INSTANCING
   stW = instanceMatrix * stW;
#endif
   vWP = (modelMatrix * stW).xyz; }`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uWet, uMoss;
varying vec4 vReg; varying vec3 vInf; varying vec3 vWP;${NOISE}`)
    .replace('#include <map_fragment>', `
 vec2 stUV = vReg.xy + fract(vMapUv) * vReg.zw;
 vec2 stDx = dFdx(vMapUv) * vReg.zw, stDy = dFdy(vMapUv) * vReg.zw;
 vec4 stA = textureGrad(map, stUV, stDx, stDy);
 vec4 stN = textureGrad(normalMap, stUV, stDx, stDy);
 vec3 stGN = normalize(cross(dFdx(vWP), dFdy(vWP)));
 if (dot(stGN, cameraPosition - vWP) < 0.) stGN = -stGN;
 // procedural moss (world space): thicker on up-facing surfaces and low down
 float stM = 0.; float stMn = 0.;
 if (vInf.z * uMoss > .01) {
   stMn = stFbm(vWP.xz * 3.1 + vWP.y * 1.7) * .5 + stFbm(vec2((vWP.x - vWP.z) * 9., vWP.y * 3.3 + (vWP.x + vWP.z) * 2.)) * .5;
   float k = vInf.z * uMoss * (.55 + .6 * smoothstep(.1, .8, stGN.y));
   stM = smoothstep(.78, .9, stMn + k * .55) * min(1., k * 2.);
 }
 float stWet = clamp(vInf.y * uWet, 0., 1.);
 vec3 stAlb = stA.rgb * vInf.x;
 vec3 stMc = mix(vec3(.022, .040, .008), vec3(.075, .12, .018), stNoise(vWP.xz * 23. + vWP.y * 17.)) * (.7 + .6 * stMn);
 stAlb = mix(stAlb, stMc, stM);
 stAlb *= mix(1., .56, stWet * (1. - stM * .7));
 diffuseColor.rgb *= stAlb;`)
    .replace('#include <roughnessmap_fragment>', `
 float roughnessFactor = mix(stN.b, .97, stM);
 roughnessFactor = mix(roughnessFactor, roughnessFactor * .62, stWet * (1. - stM));`)
    .replace('#include <normal_fragment_maps>', `
 { vec3 mapN = vec3(stN.xy * 2. - 1., 0.); mapN.xy *= normalScale * (1. - stM * .6);
   mapN.z = sqrt(max(.001, 1. - dot(mapN.xy, mapN.xy)));
   normal = normalize(tbn * mapN); }`);
};
woodMat.customProgramCacheKey = () => 'struct-wood-1';
const wireMat = new THREE.MeshStandardMaterial({ map: TX.w, alphaTest: .45, metalness: .55, roughness: .4, color: 0xcfcfc6 });

// ───────────────────────── small vector helpers (plain arrays)
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const UP = [0, 1, 0];
const _p = [0, 0, 0], _n = [0, 0, 0];
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const info = (bright, wet, moss, region) => [Math.min(255, Math.round(bright * 127.5)), Math.round(wet * 255), Math.round(moss * 255), region];

// ───────────────────────── merged-mesh builder (growable typed arrays)
class MB {
  constructor() { this.n = 0; this.cap = 128; this.P = new Float32Array(this.cap * 3); this.N = new Float32Array(this.cap * 3); this.U = new Float32Array(this.cap * 2); this.I = new Uint8Array(this.cap * 4); this.ix = new Uint32Array(this.cap * 3); this.ni = 0; }
  _grow() { const c = this.cap * 2, g = (a, k) => { const b = new a.constructor(c * k); b.set(a); return b; }; this.P = g(this.P, 3); this.N = g(this.N, 3); this.U = g(this.U, 2); this.I = g(this.I, 4); this.cap = c; }
  v(p, n, u, v, inf) { if (this.n >= this.cap) this._grow(); const i = this.n++, j = i * 3; this.P[j] = p[0]; this.P[j + 1] = p[1]; this.P[j + 2] = p[2]; this.N[j] = n[0]; this.N[j + 1] = n[1]; this.N[j + 2] = n[2]; this.U[i * 2] = u; this.U[i * 2 + 1] = v; const k = i * 4; this.I[k] = inf[0]; this.I[k + 1] = inf[1]; this.I[k + 2] = inf[2]; this.I[k + 3] = inf[3]; return i; }
  t(a, b, c) { if (this.ni + 3 > this.ix.length) { const b2 = new Uint32Array(this.ix.length * 2); b2.set(this.ix); this.ix = b2; } this.ix[this.ni++] = a; this.ix[this.ni++] = b; this.ix[this.ni++] = c; }
  // quad a,b,c,d with winding fixed so the front face points along n
  q(a, b, c, d, n) { const pa = this.P, A = a * 3, B = b * 3, C = c * 3;
    const ux = pa[B] - pa[A], uy = pa[B + 1] - pa[A + 1], uz = pa[B + 2] - pa[A + 2], vx = pa[C] - pa[A], vy = pa[C + 1] - pa[A + 1], vz = pa[C + 2] - pa[A + 2];
    const s = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
    if (s >= 0) { this.t(a, b, c); this.t(a, c, d); } else { this.t(a, c, b); this.t(a, d, c); } }
  get tris() { return this.ni / 3; }
  build(withInfo = true) {
    if (!this.n) return null; const g = new THREE.BufferGeometry(), n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.P.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.N.slice(0, n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.U.slice(0, n * 2), 2));
    if (withInfo) g.setAttribute('aInfo', new THREE.BufferAttribute(this.I.slice(0, n * 4), 4, true));
    g.setIndex(new THREE.BufferAttribute(n < 65536 ? Uint16Array.from(this.ix.subarray(0, this.ni)) : this.ix.slice(0, this.ni), 1));
    g.computeBoundingBox(); g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere()); return g;
  }
}

// flat quad from 4 corners
function quad(b, p0, p1, p2, p3, n, uv, inf) {
  const a = b.v(p0, n, uv[0], uv[1], inf), c = b.v(p1, n, uv[2], uv[3], inf), d = b.v(p2, n, uv[4], uv[5], inf), e = b.v(p3, n, uv[6], uv[7], inf); b.q(a, c, d, e, n);
}
// oriented box: centre c, unit axes ax (length) and ay (width/height); az = ax × ay. Wide faces (±az) carry the
// grain along ax (u = along / uLen + u0, v 0..1 over ay); narrow faces (±ay) take a sliver; ends (±ax) end grain.
const _C = new Float64Array(24), _ie = [0, 0, 0, 0];
// face table: corner indices (sx,sy,sz bits: x=1,y=2,z=4), normal axis/sign, kind (0 wide, 1 narrow, 2 end)
const BOXF = [[[0, 1, 3, 2], 2, -1, 0], [[4, 5, 7, 6], 2, 1, 0], [[0, 1, 5, 4], 1, -1, 1], [[2, 3, 7, 6], 1, 1, 1], [[0, 2, 6, 4], 0, -1, 2], [[1, 3, 7, 5], 0, 1, 2]];
function box(b, c, ax, ay, hx, hy, hz, inf, uLen, u0 = 0, ends = true, endReg = R.end) {
  const az = cross(ax, ay), u1 = u0 + 2 * hx / uLen, AX = [ax, ay, az];
  for (let k = 0; k < 8; k++) { const sx = k & 1 ? hx : -hx, sy = k & 2 ? hy : -hy, sz = k & 4 ? hz : -hz;
    for (let d = 0; d < 3; d++) _C[k * 3 + d] = c[d] + ax[d] * sx + ay[d] * sy + az[d] * sz; }
  _ie[0] = inf[0] * .8; _ie[1] = inf[1]; _ie[2] = inf[2]; _ie[3] = endReg;
  for (const [cs, axi, sg, kind] of BOXF) {
    if (kind === 2 && !ends) continue;
    const A = AX[axi]; _n[0] = A[0] * sg; _n[1] = A[1] * sg; _n[2] = A[2] * sg;
    const fi = kind === 2 ? _ie : inf, base = b.n;
    for (const k of cs) {
      _p[0] = _C[k * 3]; _p[1] = _C[k * 3 + 1]; _p[2] = _C[k * 3 + 2];
      let u, v;
      if (kind === 2) { u = k & 2 ? .7 : .3; v = k & 4 ? .7 : .3; }
      else { u = k & 1 ? u1 : u0; v = kind === 0 ? (k & 2 ? 1 : 0) : (sg > 0 ? (k & 4 ? 1 : .9) : (k & 4 ? .1 : 0)); }
      b.v(_p, _n, u, v, fi);
    }
    b.q(base, base + 1, base + 2, base + 3, _n);
  }
}
// small flat square (bolt heads, washers) facing fn
function plate(b, c, fn, ax, h, inf) {
  const ay = cross(fn, ax), base = b.n;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { _p[0] = c[0] + (ax[0] * sx + ay[0] * sy) * h; _p[1] = c[1] + (ax[1] * sx + ay[1] * sy) * h; _p[2] = c[2] + (ax[2] * sx + ay[2] * sy) * h; b.v(_p, fn, .5 + sx * .02, .5 + sy * .02, inf); }
  b.q(base, base + 1, base + 2, base + 3, fn);
}
// a board from A to B (centre line), its wide face facing fn
function board(b, A, B, fn, w, t, inf, ext = 0, u0 = 0) {
  const L = sub(B, A), len = Math.hypot(L[0], L[1], L[2]), ax = mul(L, 1 / len);
  let ay = norm(cross(fn, ax)); const c = mul(add(A, B), .5);
  box(b, c, ax, ay, len / 2 + ext, w / 2, t / 2, inf, LUMBER_LEN, u0);
}
// round post / log from p0 to p1; inf0/inf1 at the ends (wetness/moss gradients). Top cap optional.
function cyl(b, p0, p1, r0, r1, sides, inf0, inf1, vLen, rot, cap0, cap1, v0 = 0) {
  const A = norm(sub(p1, p0)), ref = Math.abs(A[1]) < .9 ? UP : [1, 0, 0];
  const E1 = norm(cross(ref, A)), E2 = cross(A, E1), len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const base = b.n, v1 = v0 + len / vLen, cs = _cs, sn = _sn;
  for (let k = 0; k <= sides; k++) { const a = rot + k / sides * Math.PI * 2; cs[k] = Math.cos(a); sn[k] = Math.sin(a); }
  for (let k = 0; k <= sides; k++) {
    _n[0] = E1[0] * cs[k] + E2[0] * sn[k]; _n[1] = E1[1] * cs[k] + E2[1] * sn[k]; _n[2] = E1[2] * cs[k] + E2[2] * sn[k];
    _p[0] = p0[0] + _n[0] * r0; _p[1] = p0[1] + _n[1] * r0; _p[2] = p0[2] + _n[2] * r0; b.v(_p, _n, k / sides, v0, inf0);
    _p[0] = p1[0] + _n[0] * r1; _p[1] = p1[1] + _n[1] * r1; _p[2] = p1[2] + _n[2] * r1; b.v(_p, _n, k / sides, v1, inf1);
  }
  // outward winding is fixed for this ring order: check once
  const flip = (() => { const i = base * 3, P = b.P; const ux = P[i + 6] - P[i], uy = P[i + 7] - P[i + 1], uz = P[i + 8] - P[i + 2], vx = P[i + 3] - P[i], vy = P[i + 4] - P[i + 1], vz = P[i + 5] - P[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; return nx * b.N[i] + ny * b.N[i + 1] + nz * b.N[i + 2] < 0; })();
  for (let k = 0; k < sides; k++) { const i = base + k * 2; if (!flip) { b.t(i, i + 2, i + 3); b.t(i, i + 3, i + 1); } else { b.t(i, i + 3, i + 2); b.t(i, i + 1, i + 3); } }
  for (let e = 0; e < 2; e++) {
    if (!(e ? cap1 : cap0)) continue; const p = e ? p1 : p0, r = e ? r1 : r0, inf = e ? inf1 : inf0, sg = e ? 1 : -1;
    _n2[0] = A[0] * sg; _n2[1] = A[1] * sg; _n2[2] = A[2] * sg;
    const ie = [inf[0] * .9, inf[1], 0, R.end]; const c0 = b.v(p, _n2, .5, .5, ie), ring = b.n;
    for (let k = 0; k < sides; k++) { _p[0] = p[0] + (E1[0] * cs[k] + E2[0] * sn[k]) * r; _p[1] = p[1] + (E1[1] * cs[k] + E2[1] * sn[k]) * r; _p[2] = p[2] + (E1[2] * cs[k] + E2[2] * sn[k]) * r; b.v(_p, _n2, .5 + .42 * cs[k], .5 + .42 * sn[k], ie); }
    // ring runs counter-clockwise about A (E1→E2), so the fan faces +A in that order
    for (let k = 0; k < sides; k++) { const i0 = ring + k, i1 = ring + (k + 1) % sides; if (e) b.t(c0, i0, i1); else b.t(c0, i1, i0); }
  }
}
const _cs = new Float64Array(64), _sn = new Float64Array(64), _n2 = [0, 0, 0];

// ───────────────────────── sweeps along a structure
// frames: [{p:[x,y,z] (origin), N:[lateral], T:[tangent], s (arc length)}]; profile edges in (lateral, up) coords:
// {a:[x,y], b:[x,y], na:[nx,ny], nb:[nx,ny], ua, ub (texture coord across), reg, inf (bright, wet, moss)}.
// alongV: the along-path coordinate goes into v (bark, split log top) instead of u (lumber).
function sweep(b, frames, edges, len, alongV, off = 0) {
  for (const e of edges) {
    const base = b.n, inf = info(e.inf[0], e.inf[1], e.inf[2], e.reg);
    for (const f of frames) {
      const sl = f.s / len + off;
      for (let side = 0; side < 2; side++) {
        const q = side ? e.b : e.a, qn = side ? e.nb : e.na;
        _p[0] = f.p[0] + f.N[0] * q[0]; _p[1] = f.p[1] + q[1]; _p[2] = f.p[2] + f.N[2] * q[0];
        let nx = f.N[0] * qn[0], ny = qn[1], nz = f.N[2] * qn[0]; const d = nx * f.T[0] + ny * f.T[1] + nz * f.T[2];
        nx -= f.T[0] * d; ny -= f.T[1] * d; nz -= f.T[2] * d; const l = Math.hypot(nx, ny, nz) || 1; _n[0] = nx / l; _n[1] = ny / l; _n[2] = nz / l;
        const ua = side ? e.ub : e.ua;
        if (alongV) b.v(_p, _n, ua, sl, inf); else b.v(_p, _n, sl, ua, inf);
      }
    }
    for (let k = 0; k < frames.length - 1; k++) { const i = base + k * 2; _n[0] = b.N[i * 3] + b.N[i * 3 + 6]; _n[1] = b.N[i * 3 + 1] + b.N[i * 3 + 7]; _n[2] = b.N[i * 3 + 2] + b.N[i * 3 + 8]; b.q(i, i + 1, i + 3, i + 2, _n); }
  }
}
// end cap for a convex profile at frame f (normal dir = ±T)
function capProfile(b, f, pts, dir, inf) {
  const n = mul(f.T, dir); let cx = 0, cy = 0; for (const p of pts) { cx += p[0]; cy += p[1]; } cx /= pts.length; cy /= pts.length;
  const P = q => [f.p[0] + f.N[0] * q[0], f.p[1] + q[1], f.p[2] + f.N[2] * q[0]];
  const ie = [inf[0], inf[1], inf[2], R.end]; let mx = .01; for (const p of pts) mx = Math.max(mx, Math.abs(p[0] - cx), Math.abs(p[1] - cy));
  const c0 = b.v(P([cx, cy]), n, .5, .5, ie), ring = b.n;
  for (const p of pts) b.v(P(p), n, .5 + (p[0] - cx) / mx * .45, .5 + (p[1] - cy) / mx * .45, ie);
  for (let k = 0; k < pts.length; k++) { const i0 = ring + k, i1 = ring + (k + 1) % pts.length; const pa = b.P, a3 = c0 * 3, b3 = i0 * 3, c3 = i1 * 3;
    const s = dot(cross([pa[b3] - pa[a3], pa[b3 + 1] - pa[a3 + 1], pa[b3 + 2] - pa[a3 + 2]], [pa[c3] - pa[a3], pa[c3 + 1] - pa[a3 + 1], pa[c3 + 2] - pa[a3 + 2]]), n);
    if (s >= 0) b.t(c0, i0, i1); else b.t(c0, i1, i0); }
}
const rectEdges = (l0, l1, top, h, reg, inf, sides = 'tlrb') => {
  const E = [], bot = top - h;
  if (sides.includes('t')) E.push({ a: [l0, top], b: [l1, top], na: [0, 1], nb: [0, 1], ua: 0, ub: 1, reg, inf });
  if (sides.includes('r')) E.push({ a: [l1, top], b: [l1, bot], na: [1, 0], nb: [1, 0], ua: 0, ub: 1, reg, inf: [inf[0] * .9, inf[1], inf[2]] });
  if (sides.includes('b')) E.push({ a: [l1, bot], b: [l0, bot], na: [0, -1], nb: [0, -1], ua: 0, ub: 1, reg, inf: [inf[0] * .8, inf[1], inf[2]] });
  if (sides.includes('l')) E.push({ a: [l0, bot], b: [l0, top], na: [-1, 0], nb: [-1, 0], ua: 0, ub: 1, reg, inf: [inf[0] * .9, inf[1], inf[2]] });
  return E;
};
function logEdges(segs, inf, mossy) {
  const E = [{ a: [-LOG_A, 0], b: [LOG_A, 0], na: [0, 1], nb: [0, 1], ua: .02, ub: .98, reg: R.split, inf }];
  const f0 = Math.atan2(LOG_C, LOG_A), span = Math.PI * 2 - 2 * f0 + 0; // from the right edge of the flat, clockwise round the bottom
  let prev = null;
  for (let k = 0; k <= segs; k++) {
    const f = f0 - k / segs * (Math.PI + 2 * f0) * 1 - 0, c = Math.cos(f), s = Math.sin(f);
    const p = [LOG_R * c, -LOG_C + LOG_R * s], n = [c, s], u = k / segs * 1.6;
    if (prev) E.push({ a: prev.p, b: p, na: prev.n, nb: n, ua: prev.u, ub: u, reg: R.bark, inf: [inf[0] * .95, inf[1], mossy] });
    prev = { p, n, u };
  }
  return E;
}
const logOutline = segs => { const pts = [[-LOG_A, 0], [LOG_A, 0]]; const f0 = Math.atan2(LOG_C, LOG_A); for (let k = 1; k < segs; k++) { const f = f0 - k / segs * (Math.PI + 2 * f0); pts.push([LOG_R * Math.cos(f), -LOG_C + LOG_R * Math.sin(f)]); } return pts; };

// ───────────────────────── plank geometry (shared by every chunk's InstancedMesh)
// Local: length along x (−.5….5, scaled per instance), width along z (±PL_W/2), top at y=0. Chamfered top edges.
const PLANK_GEO = (() => {
  const b = { p: [], n: [], uv: [], sh: [], ix: [] }; const c = .009, h = PL_W / 2, t = PL_T;
  const V = (p, n, u, v, s) => { b.p.push(...p); b.n.push(...n); b.uv.push(u, v); b.sh.push(s); return b.p.length / 3 - 1; };
  const Q = (a, bb, cc, d, n) => { const pa = i => [b.p[i * 3], b.p[i * 3 + 1], b.p[i * 3 + 2]]; const s = dot(cross(sub(pa(bb), pa(a)), sub(pa(cc), pa(a))), n); if (s >= 0) b.ix.push(a, bb, cc, a, cc, d); else b.ix.push(a, cc, bb, a, d, cc); };
  const U0 = .004, U1 = .996;
  // cross-section (z, y) going round: side −z, chamfer, top, chamfer, side +z
  const cs = [[-h, -t], [-h, -c], [-h + c, 0], [h - c, 0], [h, -c], [h, -t]];
  const vOf = z => .004 + (z + h) / (2 * h) * .992;
  const faces = [[0, 1, .62, [0, 0, -1]], [1, 2, .85, norm([0, 1, -1])], [2, 3, 1, [0, 1, 0]], [3, 4, .85, norm([0, 1, 1])], [4, 5, .62, [0, 0, 1]]];
  for (const [i0, i1, sh, n] of faces) {
    const za = cs[i0][0], ya = cs[i0][1], zb = cs[i1][0], yb = cs[i1][1];
    const va = i0 === 0 ? .004 : i1 === 5 ? .9 : vOf(za), vb = i0 === 0 ? .08 : i1 === 5 ? .996 : vOf(zb);
    const a = V([-.5, ya, za], n, U0, va, sh), bb = V([.5, ya, za], n, U1, va, sh), cc = V([.5, yb, zb], n, U1, vb, sh), d = V([-.5, yb, zb], n, U0, vb, sh); Q(a, bb, cc, d, n);
  }
  for (const sx of [-1, 1]) {   // end grain caps (hexagon), sampled from the darkened plank end
    const n = [sx, 0, 0], c0 = V([sx * .5, -t / 2, 0], n, sx < 0 ? .01 : .99, .5, .55), ring = b.p.length / 3;
    for (const [z, y] of cs) V([sx * .5, y, z], n, sx < 0 ? .004 : .996, vOf(z), .55);
    for (let k = 0; k < 6; k++) { const i0 = ring + k, i1 = ring + (k + 1) % 6; const pa = i => [b.p[i * 3], b.p[i * 3 + 1], b.p[i * 3 + 2]]; const s = dot(cross(sub(pa(i0), pa(c0)), sub(pa(i1), pa(c0))), n); if (s >= 0) b.ix.push(c0, i0, i1); else b.ix.push(c0, i1, i0); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2)); g.setAttribute('aShade', new THREE.Float32BufferAttribute(b.sh, 1)); g.setIndex(b.ix);
  return g;
})();

// ───────────────────────── chunks
// Two passes share buildOne(): MODE 0 emits the far LOD of every chunk; MODE 1 emits the near detail of ONE chunk
// (KEY) and sends everything else to a null sink. The main rng sequence never depends on the mode, and planks use
// their own stream, so both passes see the identical structure.
class NullMB extends MB { v() { return 0; } t() {} q() {} }
const NULL = new NullMB(), SINK = { near: NULL, far: NULL, wire: NULL, sink: true };
class Chunk {
  constructor(i, j, k) { this.i = i; this.j = j; this.k = k; this.far = new MB(); this.farView = { near: NULL, far: this.far, wire: NULL, sink: true };
    this.view = null; this.structs = []; this.built = false; this.isNear = false; }
}
let CHUNKS = new Map(), MODE = 0, KEY = 0;
const keyOf = (i, j) => i * 100000 + j;
function chunkAt(x, z) {
  const i = Math.floor(x / CH), j = Math.floor(z / CH), k = keyOf(i, j); let c = CHUNKS.get(k);
  if (!c) { if (MODE === 1) return SINK; CHUNKS.set(k, c = new Chunk(i, j, k)); }
  return MODE === 0 ? c.farView : k === KEY ? c.view : SINK;
}

// mountain look: how wet, how mossy, which planks
const STYLE = {
  shoreline: { wet: 1, moss: 1, plankW: [5, 4, 4, 5, 6, 5, 1, 1, 4, 4, 4, 4, 1, 3, 3], lumberW: [4, 1, 4, 2] },
  ridgeline: { wet: .45, moss: .45, plankW: [6, 6, 5, 6, 2, 2, 2, 2, 2, 2, .5, .5, 1, 1, 1], lumberW: [5, 2, 1, 4] },
  widowmaker: { wet: .3, moss: .25, plankW: [6, 7, 5, 7, 1, 1, 2, 2, 3, 3, .2, .2, 1, .5, .5], lumberW: [5, 2, .5, 5] },
  razorback: { wet: .15, moss: .05, plankW: [6, 7, 5, 7, 1, 1, 2, 2, 3, 3, .2, .2, 1, .5, .5], lumberW: [5, 2, .5, 5] },   // sun-bleached, dry
};
const pick = (w, r) => { let t = 0; for (const x of w) t += x; let q = r() * t; for (let i = 0; i < w.length; i++) { q -= w[i]; if (q <= 0) return i; } return w.length - 1; };

// per-structure frames: arc length, smoothed 3D tangents, horizontal laterals
function framesOf(st) {
  const P = st.pts, n = P.length, S = new Float64Array(n), T = [];
  for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y, P[i].z - P[i - 1].z);
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    T.push(norm([b.x - a.x, b.y - a.y, b.z - a.z]));
  }
  const N = T.map(t => norm([-t[2], 0, t[0]]));
  return { P, n, S, T, N };
}
function sampleAt(F, s) {
  let lo = 0, hi = F.n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (F.S[m] <= s) lo = m; else hi = m; }
  const a = F.P[lo], b = F.P[hi], L = F.S[hi] - F.S[lo] || 1, t = Math.min(1, Math.max(0, (s - F.S[lo]) / L));
  const T = norm([F.T[lo][0] + (F.T[hi][0] - F.T[lo][0]) * t, F.T[lo][1] + (F.T[hi][1] - F.T[lo][1]) * t, F.T[lo][2] + (F.T[hi][2] - F.T[lo][2]) * t]);
  return { i: lo, t, p: [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t], T, N: norm([-T[2], 0, T[0]]) };
}
// split frame indices [i0..i1] into runs by chunk (segment midpoint), call fn(chunk, frames)
function runs(F, i0, i1, mk, fn) {
  let start = i0, cur = null;
  const ck = k => { const a = F.P[k], b = F.P[k + 1]; return chunkAt((a.x + b.x) / 2, (a.z + b.z) / 2); };
  for (let k = i0; k < i1; k++) { const c = ck(k); if (cur && c !== cur) { fn(cur, mk(start, k)); start = k; } cur = c; }
  if (cur) fn(cur, mk(start, i1));
}

// ───────────────────────── one structure
const _m = new THREE.Matrix4(), _r = new THREE.Matrix4(), _s = new THREE.Matrix4(), _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3();
function buildOne(st, S, r, rp) {
  const F = st._F || (st._F = framesOf(st)), P = F.P, n = F.n, w = st.w, Send = F.S[n - 1];
  const kind = st.kind === 'skinny' ? (st.id % 2 ? 'strip' : 'log') : 'deck';
  const DD = kind === 'deck' ? PL_T + STR_H : kind === 'strip' ? PL_T + .14 : LOG_C + LOG_R - .02;  // deck top → bearer top
  const wetBase = .55 + r() * .35, mossK = S.moss;
  const lum = () => R.lumber[pick(S.lumberW, r)];
  const frame = (k, dy = 0, extra = 0) => ({ p: [P[k].x, P[k].y + dy, P[k].z], N: F.N[k], T: F.T[k], s: F.S[k] + extra });
  const FR = F.fr || (F.fr = P.map((_, k) => frame(k)));
  const mkFrames = (dy) => (a, b) => FR.slice(a, b + 1);

  // chicken wire where the deck is steep (and on the entry / exit ramps)
  const wireSeg = new Uint8Array(n);
  for (let i = 0; i < n - 1; i++) {
    const a = P[i], b = P[i + 1], sl = Math.abs(b.y - a.y) / (Math.hypot(b.x - a.x, b.z - a.z) || 1);
    if (sl > (S === STYLE.shoreline ? .15 : .19) || (i < 3 && kind === 'deck') || (!st.drop && i >= n - 5)) wireSeg[i] = 1;
  }
  for (let i = 1; i < n - 2; i++) if (!wireSeg[i] && wireSeg[i - 1] && wireSeg[i + 1]) wireSeg[i] = 1;   // close single gaps

  // ── decking
  if (kind === 'deck' && MODE === 1) {
    let s = .085; const last = Send - .085; const r = rp;
    while (s < last) {
      const lip = st.drop && s + PL_PITCH > last;
      const odd = r() < .05;
      const L = w + (r() - .35) * .07 - (odd ? .06 : 0), lat = (r() - .5) * .035 + (odd ? (r() < .5 ? -.04 : .04) : 0);
      const yaw = (r() - .5) * .036, roll = (r() - .5) * .012, dy = -.003 + r() * .007, flip = r() < .5, v = lip ? LIP : pick(S.plankW, r), br = .86 + r() * .26, wt = .55 + r() * .6;
      const s0 = s; s += PL_PITCH + (r() - .5) * .01;
      const q = sampleAt(F, s0), c = chunkAt(q.p[0], q.p[2]); if (c.sink) continue;
      // sit the plank on the secant across its own width, so both edges lie on the (piecewise-linear) riding surface
      const qa = sampleAt(F, Math.max(0, s0 - PL_W / 2)).p, qb = sampleAt(F, Math.min(Send, s0 + PL_W / 2)).p;
      const kink = Math.abs(q.p[1] - (qa[1] + qb[1]) / 2) > .006;   // plank straddles a slope change: no jitter
      q.T = norm(sub(qb, qa)); q.N = norm([-q.T[2], 0, q.T[0]]); q.p = [(qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2 + (kink ? (q.p[1] - (qa[1] + qb[1]) / 2) * .5 : 0), (qa[2] + qb[2]) / 2];
      // basis: X lateral, Y up-ish (perpendicular to the sloped deck), Z = X × Y (backwards along the path)
      _X.set(q.N[0], q.N[1], q.N[2]); _Z.set(-q.T[0], -q.T[1], -q.T[2]); _Y.crossVectors(_Z, _X).normalize(); _Z.crossVectors(_X, _Y);
      _m.makeBasis(_X, _Y, _Z);
      _r.makeRotationY((Math.abs(q.T[1]) > .3 ? yaw * .15 : yaw) + (!lip && flip ? Math.PI : 0)); _m.multiply(_r); _r.makeRotationZ(kink ? 0 : roll); _m.multiply(_r); _s.makeScale(L, 1, 1); _m.multiply(_s);
      _m.setPosition(q.p[0] + q.N[0] * lat, q.p[1] + (kink ? 0 : dy), q.p[2] + q.N[2] * lat);
      if (c.np * 16 >= c.pm.length) { const a = new Float32Array(c.pm.length * 2); a.set(c.pm); c.pm = a; const b2 = new Uint8Array(c.pi.length * 2); b2.set(c.pi); c.pi = b2; }
      c.pm.set(_m.elements, c.np * 16);
      c.pi.set(info(br, wetBase * wt, 0, R.plank[v]), c.np * 4); c.np++;
    }
  }
  if (MODE === 1) {
  const rn = mulberry(seedOf(st) ^ 0x2c1b3c6d), lumN = () => R.lumber[pick(S.lumberW, rn)];
  if (kind === 'deck') {
    // stringers: three lines, in pieces that join over the bearers
    for (const lat of [-.393 * w, 0, .393 * w]) {
      let i0 = 0, ph = Math.floor(rn() * 6);
      while (i0 < n - 1) {
        let i1 = Math.min(n - 1, i0 + 6 - ((i0 + ph) % 3)); if (n - 1 - i1 < 3) i1 = n - 1;
        const reg = lumN(), inf = [.78 + rn() * .2, wetBase, .35], off = rn();
        const edges = rectEdges(lat - STR_W / 2, lat + STR_W / 2, -PL_T, STR_H, reg, inf);
        runs(F, i0, i1, mkFrames(0), (c, fr) => sweep(c.near, fr, edges, LUMBER_LEN, false, off));
        const outline = [[lat - STR_W / 2, -PL_T], [lat + STR_W / 2, -PL_T], [lat + STR_W / 2, -PL_T - STR_H], [lat - STR_W / 2, -PL_T - STR_H]];
        if (i0 === 0) capProfile(chunkAt(P[0].x, P[0].z).near, frame(0), outline, -1, info(inf[0], inf[1], 0, 0));
        if (i1 === n - 1) capProfile(chunkAt(P[n - 1].x, P[n - 1].z).near, frame(n - 1), outline, 1, info(inf[0], inf[1], 0, 0));
        i0 = i1;
      }
    }
  } else if (kind === 'strip') {
    for (const lat of [-.168, .168]) {
      let i0 = 0;
      while (i0 < n - 1) {
        let i1 = Math.min(n - 1, i0 + 3 + Math.floor(rn() * 3)); if (n - 1 - i1 < 2) i1 = n - 1;
        const reg = lumN(), inf = [.85 + rn() * .25, wetBase, .1], off = rn();
        const edges = rectEdges(lat - .155, lat + .155, -.002 + rn() * .004, PL_T, reg, inf, 'tlrb');
        runs(F, i0, i1, mkFrames(0), (c, fr) => sweep(c.near, fr, edges, LUMBER_LEN, false, off));
        i0 = i1;
      }
      const reg = lumN(), inf = [.75, wetBase, .4];
      runs(F, 0, n - 1, mkFrames(0), (c, fr) => sweep(c.near, fr, rectEdges(lat - STR_W / 2, lat + STR_W / 2, -PL_T, .14, reg, inf, 'lrb'), LUMBER_LEN, false, rn()));
    }
  } else {   // split log, in pieces of 5–8 m
    let i0 = 0;
    while (i0 < n - 1) {
      let i1 = Math.min(n - 1, i0 + 5 + Math.floor(rn() * 4)); if (n - 1 - i1 < 3) i1 = n - 1;
      const inf = [.85 + rn() * .25, wetBase, .2], edges = logEdges(8, inf, .9), off = rn();
      runs(F, i0, i1, mkFrames(0), (c, fr) => sweep(c.near, fr, edges, .66, true, off));
      const ol = logOutline(8);
      capProfile(chunkAt(P[i0].x, P[i0].z).near, frame(i0, 0, 0), ol, -1, info(inf[0] * .9, inf[1], 0, 0));
      capProfile(chunkAt(P[i1].x, P[i1].z).near, frame(i1), ol, 1, info(inf[0] * .9, inf[1], 0, 0));
      i0 = i1;
    }
  }

  }
  // ── far deck strip
  {
    let edges;
    if (kind === 'log') { const inf = [.9, wetBase, .2]; edges = logEdges(3, inf, .6); }
    else { const top = { a: [-w / 2, 0], b: [w / 2, 0], na: [0, 1], nb: [0, 1], ua: .01, ub: .99, reg: kind === 'deck' ? R.far : R.lumber[0], inf: [.8, wetBase, 0] };
      edges = [top, ...rectEdges(-w / 2 + .03, w / 2 - .03, -PL_T, DD - PL_T, R.lumber[0], [.55, wetBase, 0], 'lrb')]; }
    runs(F, 0, n - 1, mkFrames(0), (c, fr) => sweep(c.far, fr, edges, kind === 'log' ? .66 : FAR_LEN, true, 0));
  }

  // ── chicken wire strips
  if (MODE === 1) {
    const ww = kind === 'deck' ? Math.min(.92, w - .3) : kind === 'log' ? .5 : .56, inf = [0, 0, 0, 0];
    for (let i = 0; i < n - 1; i++) if (wireSeg[i]) {
      const a = frame(i, .012), b = frame(i + 1, .012), c = chunkAt((a.p[0] + b.p[0]) / 2, (a.p[2] + b.p[2]) / 2).wire;
      const nrm = norm(cross(sub(b.p, a.p), a.N)); const nn = nrm[1] < 0 ? mul(nrm, -1) : nrm;
      const P0 = madd(a.p, a.N, -ww / 2), P1 = madd(a.p, a.N, ww / 2), P2 = madd(b.p, b.N, ww / 2), P3 = madd(b.p, b.N, -ww / 2);
      quad(c, P0, P1, P2, P3, nn, [0, a.s / .2, ww / .2, a.s / .2, ww / .2, b.s / .2, 0, b.s / .2], inf);
    }
  }

  // ── bents: posts (exactly where terrainfn.postsIn puts its colliders), bearers, bracing; sleepers on low spans
  const bents = [];
  {
    let acc = 0;
    for (let i = 1; i < n; i++) { acc += 1; if (acc < 2.4) continue; acc = 0; bents.push({ i, post: P[i].y - P[i].g >= .5 }); }
    // a cantilevered drop end gets an extra (visual) bent close to the lip
    const lb = bents.length ? bents[bents.length - 1].i : 0;
    if (st.drop && n - 1 - lb >= 2 && P[n - 2].y - P[n - 2].g >= .7) bents.push({ i: n - 2, post: true, extra: true });
  }
  const half = w / 2 - .08, bearHalf = kind === 'deck' ? w / 2 + .1 : .45;
  const y0c = st._y0 || (st._y0 = new Map());
  const postAt = (p, sd) => { const x = p.x + p.tz * sd * half * -1, z = p.z + p.tx * sd * half, key = x * 7919 + z; let y0 = y0c.get(key); if (y0 === undefined) y0c.set(key, y0 = heightAt(x, z)); return { x, z, y0 }; };
  const B = [];
  for (const bt of bents) {
    const p = P[bt.i], h = p.y - p.g, Nb = [-p.tz, 0, p.tx], Tb = [p.tx, 0, p.tz], top = p.y - DD;
    const c = chunkAt(p.x, p.z);
    if (!bt.post) {
      if (h > .12 && kind !== 'log' && MODE === 1) {   // log sleeper on the ground under the stringers (own rng: near pass only)
        const r = mulberry(seedOf(st) + bt.i * 31);
        const yc = top - .12, inf = info(.8, 1, .8, R.bark);
        cyl(c.near, [p.x - Nb[0] * (bearHalf + .05), yc, p.z - Nb[2] * (bearHalf + .05)], [p.x + Nb[0] * (bearHalf + .05), yc + (r() - .5) * .04, p.z + Nb[2] * (bearHalf + .05)], .13, .12, 7, inf, inf, POST_LEN, r() * 6, true, true);
      }
      B.push(null); continue;
    }
    const posts = [-1, 1].map(sd => postAt(p, sd));
    const rec = { i: bt.i, posts, top, Nb, Tb, h };
    B.push(rec);
    const preg = R.post[r() < .7 ? 0 : 1];
    for (const q of posts) {
      const lx = (r() - .5) * .03, lz = (r() - .5) * .03;
      const pinf0 = info(.62, 1, .9, preg), pinf1 = info(1, .45, .3, preg);
      cyl(c.near, [q.x, q.y0 - .5, q.z], [q.x + lx, top, q.z + lz], POST_R + .01, POST_R - .008, 8, pinf0, pinf1, POST_LEN, r() * 6, false, true, r());
      cyl(c.far, [q.x, q.y0 - .3, q.z], [q.x + lx, top, q.z + lz], POST_R, POST_R, 4, pinf0, pinf1, POST_LEN, .78, false, false);
    }
    // double bearers sandwiching the posts (and through-bolts)
    const binf = info(.8 + r() * .15, wetBase, .5, lum()), u0 = r();
    for (const s of [-1, 1]) {
      const cc = [p.x + Tb[0] * s * (POST_R + BEAR_T / 2), top - BEAR_H / 2, p.z + Tb[2] * s * (POST_R + BEAR_T / 2)];
      box(c.near, cc, Nb, UP, bearHalf, BEAR_H / 2, BEAR_T / 2, binf, LUMBER_LEN, u0);
      for (const q of posts) for (const by of [-.05, .05]) {
        const bp = [q.x + Tb[0] * s * (POST_R + BEAR_T + .004), top - BEAR_H / 2 + by, q.z + Tb[2] * s * (POST_R + BEAR_T + .004)];
        plate(c.near, bp, mul(Tb, s), Nb, .02, BOLT);
      }
    }
    box(c.far, [p.x, top - BEAR_H / 2, p.z], Nb, UP, bearHalf, BEAR_H / 2, POST_R + BEAR_T, binf, LUMBER_LEN, u0);
    // X-bracing across tall bents (front and back faces), stacked down to the ground
    const yG = Math.max(posts[0].y0, posts[1].y0), span = Math.hypot(posts[1].x - posts[0].x, posts[1].z - posts[0].z);
    let zt = top - BEAR_H - .06;
    if (zt - yG > 1.0) {
      const dv = Math.min(span * 1.05, 1.5); let lvl = 0;
      while (zt - yG > .7 && lvl < 5) {
        const d = Math.min(dv, zt - yG - .2), zb = zt - d; if (d < .55) break;
        for (const s of [-1, 1]) {
          const o = s * (POST_R + BR_T / 2 + .004), qa = posts[s < 0 ? 0 : 1], qb = posts[s < 0 ? 1 : 0];
          const A = [qa.x + Tb[0] * o, zt, qa.z + Tb[2] * o], Bp = [qb.x + Tb[0] * o, zb, qb.z + Tb[2] * o];
          const bi = info(.78 + r() * .2, wetBase, .4, lum());
          board(c.near, A, Bp, Tb, BR_W, BR_T, bi, .1, r()); board(c.far, A, Bp, Tb, BR_W, BR_T, bi, .1);
        }
        zt = zb - .12; lvl++;
      }
    }
  }
  // long diagonals between neighbouring tall bents, alternating, on the outside faces of the posts
  for (let k = 0; k < B.length - 1; k++) {
    const a = B[k], b = B[k + 1]; if (!a || !b || b.i - a.i > 4) continue;
    for (const si of [0, 1]) {
      const qa = a.posts[si], qb = b.posts[si], sd = si ? 1 : -1;
      const ha = a.top - qa.y0, hb = b.top - qb.y0; if (Math.min(ha, hb) < 1.6) continue;
      const flip = (k + si) % 2 === 1, [A, Bq, ra, rb] = flip ? [qb, qa, b, a] : [qa, qb, a, b];
      const yA = ra.top - BEAR_H - .1, yB = Math.max((flip ? qa : qb).y0 + .35, rb.top - BEAR_H - .1 - 2.3);
      const Nn = norm(add(a.Nb, b.Nb)), o = sd * (POST_R + BR_T / 2 + .004);
      const PA = [A.x + Nn[0] * o, yA, A.z + Nn[2] * o], PB = [Bq.x + Nn[0] * o, yB, Bq.z + Nn[2] * o];
      const c = chunkAt((PA[0] + PB[0]) / 2, (PA[2] + PB[2]) / 2), bi = info(.78 + r() * .2, wetBase, .4, lum());
      board(c.near, PA, PB, mul(Nn, sd), BR_W, BR_T, bi, .12, r()); board(c.far, PA, PB, mul(Nn, sd), BR_W, BR_T, bi, .12);
      if (Math.min(ha, hb) > 3.6) {   // mid-height girt on very tall runs
        const y = Math.max(qa.y0, qb.y0) + Math.min(ha, hb) * .45, o2 = sd * (POST_R + BR_T * 1.5 + .008);
        board(c.near, [qa.x + Nn[0] * o2, y, qa.z + Nn[2] * o2], [qb.x + Nn[0] * o2, y, qb.z + Nn[2] * o2], mul(Nn, sd), BR_W, BR_T, bi, .15, r());
      }
    }
  }

  // ── the lip: header board across the end of a drop, painted on top
  if (st.drop) {
    const f = frame(n - 1), c = chunkAt(f.p[0], f.p[2]), hy = (DD + .01) / 2, hx = (kind === 'log' ? LOG_R : w / 2) + .03;
    const cc = madd([f.p[0], f.p[1] - .006 - hy, f.p[2]], norm([F.T[n - 1][0], 0, F.T[n - 1][2]]), .0225);
    const ax = norm([F.N[n - 1][0], 0, F.N[n - 1][2]]);
    box(c.near, cc, ax, [0, -1, 0], hx, hy, .0225, info(1, wetBase * .6, 0, R.plank[LIP]), 2 * hx / .99, .005);
    box(c.far, cc, ax, [0, -1, 0], hx, hy, .0225, info(1, wetBase * .6, 0, R.plank[LIP]), 2 * hx / .99, .005);
  }
}

// ───────────────────────── build / dispose / update
let CUR = null;
const PLANK_TRIS = PLANK_GEO.index.count / 3;
const seedOf = (st) => 7919 + st.id * 104729 + (MOUNTAIN.seed | 0) * 13;
// near detail for one chunk: rerun every structure that touches it with emission limited to this chunk
// Incremental: one structure at a time until `deadline` (ms timestamp); returns true when the chunk is complete.
function buildNear(c, deadline = Infinity) {
  const t0 = performance.now();
  if (!c.view) { c.view = { near: new MB(), far: NULL, wire: new MB(), sink: false, pm: new Float32Array(16 * 64), pi: new Uint8Array(4 * 64), np: 0 }; c.next = 0; c.nearMs = 0; }
  MODE = 1; KEY = c.k;
  try { while (c.next < c.structs.length) { const st = STRUCTS[c.structs[c.next++]]; buildOne(st, CUR.S, mulberry(seedOf(st)), mulberry(seedOf(st) ^ 0x5bd1e995)); if (performance.now() > deadline) break; } }
  finally { MODE = 0; }
  if (c.next < c.structs.length) { c.nearMs += performance.now() - t0; return false; }
  const v = c.view, grp = c.nearObj; let tris = 0;
  const mg = v.near.build();
  if (mg) { const m = new THREE.Mesh(mg, woodMat); m.castShadow = m.receiveShadow = true; m.matrixAutoUpdate = false; grp.add(m); tris += v.near.tris; }
  if (v.np) {
    const pg = new THREE.BufferGeometry(); for (const k of ['position', 'normal', 'uv', 'aShade']) pg.setAttribute(k, PLANK_GEO.attributes[k]); pg.setIndex(PLANK_GEO.index);
    pg.setAttribute('aInfo', new THREE.InstancedBufferAttribute(v.pi.slice(0, v.np * 4), 4, true));
    const im = new THREE.InstancedMesh(pg, woodMat, v.np); im.instanceMatrix.array.set(v.pm.subarray(0, v.np * 16)); im.instanceMatrix.needsUpdate = true;
    im.castShadow = im.receiveShadow = true; im.matrixAutoUpdate = false; im.computeBoundingSphere();
    grp.add(im); tris += v.np * PLANK_TRIS; c.planks = v.np;
  }
  const wg = v.wire.build(false);
  if (wg) { const m = new THREE.Mesh(wg, wireMat); m.receiveShadow = true; m.matrixAutoUpdate = false; grp.add(m); tris += v.wire.tris; }
  c.view = null; c.built = true; c.ntri = tris; c.nearMs += performance.now() - t0;
  return true;
}
export function buildStructures() {
  const t0 = performance.now();
  const g = new THREE.Group(); g.name = 'structures';
  const S = STYLE[MOUNTAIN.id] || STYLE.ridgeline; U.uWet.value = S.wet; U.uMoss.value = S.moss;
  CHUNKS = new Map(); MODE = 0;
  CUR = { g, chunks: [], S, mt: MOUNTAIN.id };
  for (const st of STRUCTS) {
    // register the structure with every chunk its footprint (+2 m) touches
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const p of st.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    for (let i = Math.floor((x0 - 2) / CH); i <= Math.floor((x1 + 2) / CH); i++) for (let j = Math.floor((z0 - 2) / CH); j <= Math.floor((z1 + 2) / CH); j++) {
      const k = keyOf(i, j); let c = CHUNKS.get(k); if (!c) CHUNKS.set(k, c = new Chunk(i, j, k)); c.structs.push(st.id);
    }
    buildOne(st, S, mulberry(seedOf(st)), null);
  }
  let farTris = 0;
  for (const c of CHUNKS.values()) {
    // chunk bounds: the structures' points inside the chunk square (+ margin), else the far geometry
    const box = c.box = new THREE.Box3();
    for (const id of c.structs) for (const p of STRUCTS[id].pts) if (Math.floor(p.x / CH) === c.i && Math.floor(p.z / CH) === c.j) { box.expandByPoint(_v3.set(p.x, p.y + .2, p.z)); box.expandByPoint(_v3.set(p.x, p.g - .5, p.z)); }
    const fg = c.far.build();
    if (fg) { c.farObj = new THREE.Mesh(fg, woodMat); c.farObj.receiveShadow = true; c.farObj.castShadow = false; c.farObj.matrixAutoUpdate = false; g.add(c.farObj); farTris += c.far.tris; c.ftri = c.far.tris; if (box.isEmpty()) box.copy(fg.boundingBox); }
    if (box.isEmpty()) box.set(_v3.set(c.i * CH, -1e4, c.j * CH), new THREE.Vector3((c.i + 1) * CH, 1e4, (c.j + 1) * CH));
    box.expandByScalar(1.5);
    c.far = null; c.farView = null;
    c.nearObj = new THREE.Group(); c.nearObj.matrixAutoUpdate = false; c.nearObj.visible = false; g.add(c.nearObj);
    CUR.chunks.push(c);
  }
  // far LOD in 256 m super-chunks (one draw call each) unless one of their chunks is showing near detail
  const SUP = new Map();
  for (const c of CUR.chunks) { const k = keyOf(Math.floor(c.i / 4), Math.floor(c.j / 4)); let s = SUP.get(k); if (!s) SUP.set(k, s = { kids: [], box: new THREE.Box3(), obj: null, d: 0 }); s.kids.push(c); s.box.union(c.box); c.sup = s; }
  CUR.supers = [...SUP.values()];
  for (const s of CUR.supers) {
    const geos = s.kids.filter(c => c.farObj).map(c => c.farObj.geometry);
    if (geos.length > 1) { const mg = mergeGeometries(geos); mg.computeBoundingBox(); mg.boundingSphere = mg.boundingBox.getBoundingSphere(new THREE.Sphere());
      s.obj = new THREE.Mesh(mg, woodMat); s.obj.receiveShadow = true; s.obj.matrixAutoUpdate = false; s.obj.visible = false; g.add(s.obj); s.tri = mg.index.count / 3; }
  }
  const t1 = performance.now();
  // near detail around the start straight away; the rest streams in as the camera approaches (updateStructures)
  const sp = _v3.set(START.x, heightAt(START.x, START.z), START.z).clone(); let nearN = 0;
  for (const c of CUR.chunks) if (c.box.distanceToPoint(sp) < NEAR_D) { buildNear(c); c.nearObj.visible = c.isNear = true; if (c.farObj) c.farObj.visible = false; nearN++; }
  // program warm-up: renderer.compile() only sees visible objects, so keep one culled instanced plank and one wire quad
  {
    const pg = new THREE.BufferGeometry(); for (const k of ['position', 'normal', 'uv', 'aShade']) pg.setAttribute(k, PLANK_GEO.attributes[k]); pg.setIndex(PLANK_GEO.index);
    pg.setAttribute('aInfo', new THREE.InstancedBufferAttribute(new Uint8Array(4), 4, true));
    const im = new THREE.InstancedMesh(pg, woodMat, 1); im.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0)); im.castShadow = true;
    im.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1e6, 0), 1);
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); wg.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3)); wg.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
    wg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1e6, 0), 1); const wm = new THREE.Mesh(wg, wireMat);
    g.add(im, wm);
  }
  const ms = performance.now() - t0;
  g.userData.stats = { ms: +ms.toFixed(1), farMs: +(t1 - t0).toFixed(1), nearAtStart: nearN, chunks: CUR.chunks.length, farTris };
  g.userData.chunks = CUR.chunks;
  if (typeof location !== 'undefined' && location.hash === '#dev') console.log('structures', MOUNTAIN.id, JSON.stringify(g.userData.stats));
  return g;
}
// build every chunk's near detail now (tests / stats)
export function buildAllNear() { if (!CUR) return null; let t = 0, tris = 0, planks = 0; for (const c of CUR.chunks) { if (!c.built) { buildNear(c); t += c.nearMs; } tris += c.ntri || 0; planks += c.planks || 0; } return { ms: +t.toFixed(1), nearTris: tris, planks }; }
export function disposeStructures(o) {
  o.traverse(c => { if (c.isInstancedMesh) c.dispose(); if (c.geometry) c.geometry.dispose(); });
  if (CUR && CUR.g === o) CUR = null;
}
const _cp = new THREE.Vector3(), _v3 = new THREE.Vector3(), PREFETCH = 30, BUDGET_MS = isMobile ? 3 : 4;
export function updateStructures(dt, now, camera) {
  if (!CUR || !camera || CUR.mt !== MOUNTAIN.id) return;
  camera.getWorldPosition(_cp);
  const jump = !CUR.last || CUR.last.distanceTo(_cp) > 40; (CUR.last || (CUR.last = new THREE.Vector3())).copy(_cp);
  const vis = { near: 0, far: 0, tris: 0, pending: 0, draws: 0 }; let want = null;
  for (const c of CUR.chunks) { const d = c.d = c.box.distanceToPoint(_cp); if (!c.built && d < NEAR_D + PREFETCH) (want || (want = [])).push(c); }
  if (want) {   // stream near detail in, nearest first, within a per-frame time budget
    want.sort((a, b) => a.d - b.d); const t0 = performance.now();
    for (const c of want) {
      if (jump && c.d < NEAR_D) { buildNear(c); continue; }   // respawn / teleport: what is in view now, at once
      if (performance.now() - t0 > BUDGET_MS) continue; buildNear(c, t0 + BUDGET_MS); }
    vis.pending = want.filter(c => !c.built).length;
  }
  for (const c of CUR.chunks) {
    c.isNear = c.built && (c.isNear ? c.d < NEAR_D + HYST : c.d < NEAR_D);
    c.nearObj.visible = c.isNear;
    if (c.isNear) { vis.near++; vis.tris += c.ntri; vis.draws += c.nearObj.children.length; }
  }
  for (const s of CUR.supers) {
    const sd = s.box.distanceToPoint(_cp), split = !s.obj || s.kids.some(c => c.isNear);
    if (s.obj) { s.obj.visible = !split && sd < FAR_D; s.obj.castShadow = sd < SHADOW_D; if (s.obj.visible) { vis.far++; vis.tris += s.tri; vis.draws++; } }
    for (const c of s.kids) if (c.farObj) {
      c.farObj.visible = split && !c.isNear && c.d < FAR_D; c.farObj.castShadow = c.d < SHADOW_D;
      if (c.farObj.visible) { vis.far++; vis.tris += c.ftri; vis.draws++; }
    }
  }
  CUR.g.userData.vis = vis;
}
