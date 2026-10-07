// suspension.js — fork, shock and the rider's legs as real springs and dampers (2026-10-06).
// Pure JS (no three.js) so tools/susp_lab.mjs can test it in node.
//
// Everything is per unit of total mass (rider ≈ 80 kg + bike ≈ 17 kg). Three bodies stacked vertically:
//   wheels (follow the ground) → fork / shock → bike frame (MU_F of the mass) → legs → rider (the rest).
// s = suspension compression at each end (m of wheel travel), L = leg bend (m; 0 = attack position, + = lower).
// The ground moves the wheels; the frame and rider only follow through the springs, so a landing, a G-out or a
// square edge drives the suspension in at the speed of the hit, and whatever the suspension can't stop the legs
// must. Bottom-outs, hard landings and crashes come out of that instead of fixed speed limits.
// Numbers follow DH setup practice (docs/physics-brief-2026-10-06.md): sag fork ~21 %, rear ~30 %; rear coil through
// a falling leverage curve (~50 % stiffer at the end); air fork ramping in the last third; compression damping
// ~30 % of critical with a high-speed blow-off, rebound ~55 %; a hydraulic bottom-out zone in the last 12 %.
export const TRAVEL = .22, SAG_F = .046, SAG_R = .066;
export const MU_F = .12;                       // frame + upper fork + cockpit share of the mass (the rest is the rider)
const MU_R = 1 - MU_F;
const LEG_MIN = -.15;           // legs: extend 0.15 m, bend 0.30 m from the attack position
const LEG_C0 = 1.2;                 // leg damping ∝ √stiffness (ζ ≈ 0.6)
const LEG_PULL = -.4;                          // most the arms can pull the bike up, in g
// tunables (tools/susp_lab.mjs sweeps them): legs' strongest push (g), rear/fork progression, compression damping
export const TUNE = { legMax: .38, legK: 80, legPush: 5.5, rampR: 2.5, rampF: .6, lsc: .30, hsc: .35, boK: 7 };
const BO = .88 * TRAVEL;                       // start of the bottom-out zone

const phiF = s => s + TUNE.rampF * s ** 4 / TRAVEL ** 3;            // air fork: ramps up in the last third
const phiR = s => s + TUNE.rampR * s * s / TRAVEL;                // coil through a falling leverage ratio (3.1 → 2.5)
let PF = phiF(SAG_F), PR = phiR(SAG_R);
export function retune() { PF = phiF(SAG_F); PR = phiR(SAG_R); }
const critF = 2 * Math.sqrt(9.81 / SAG_F), critR = 2 * Math.sqrt(9.81 / SAG_R);   // per unit (end) mass
function damp(v, crit) {                       // two-slope: steep below the knee, blow-off above
  const k = .6;
  if (v >= 0) return crit * (v < k ? TUNE.lsc * v : TUNE.lsc * k + TUNE.hsc * (v - k));
  const a = -v; return -crit * (a < k ? .55 * a : .55 * k + .30 * (a - k));
}
// force per unit of the end's mass share, in m/s² (g at sag)
function endForce(s, v, front) {
  const g = 9.81, f = front ? g * phiF(s) / PF : g * phiR(s) / PR;
  let bo = 0; if (s > BO) { const x = (s - BO) / (TRAVEL - BO); bo = g * TUNE.boK * x * x + (v > 0 ? 25 * v * x : 0); }
  return Math.max(0, f + damp(v, front ? critF : critR) + bo);
}

export function makeSusp() { return { sF: SAG_F, sR: SAG_R, vF: 0, vR: 0, L: 0, LV: 0, load: 1, bottomF: 0, bottomR: 0, legHit: 0, peakG: 0 }; }

// One physics step. o: {ground, G (effective gravity along the suspension, m/s²: g·cos slope·cornering load),
// aB (braking deceleration, m/s²), fore (-1 back … 1 forward), legT (leg target, m), dvF, dvR (the wheels' change of
// vertical speed this step, m/s: positive = the ground pushed them up)}. Returns the state with this step's events.
export function stepSusp(S, o, dt) {
  S.bottomF = S.bottomR = 0; S.legHit = 0;
  const wF = Math.min(.8, Math.max(.2, .40 + .10 * (o.fore || 0) + .8 * (o.aB || 0) / Math.max(4, o.G)));
  const lam = [wF, 1 - wF];
  if (o.ground) { S.vF += o.dvF || 0; S.vR += o.dvR || 0; }
  const n = 8, h = dt / n, G = o.G, Lt = o.legT || 0; let load = 0, pk = 0;
  for (let k = 0; k < n; k++) {
    let fL = MU_R * Math.min(TUNE.legPush * 9.81, Math.max(LEG_PULL * 9.81, G + TUNE.legK * (S.L - Lt) + LEG_C0 * Math.sqrt(TUNE.legK) * S.LV));
    if (!o.ground) {                           // in the air the wheels drop to full extension; the legs reset
      for (const e of [0, 1]) { const s = e ? S.sR : S.sF, v = -Math.min(s / .03, 5); if (e) { S.vR = v; S.sR = Math.max(0, s + v * h); } else { S.vF = v; S.sF = Math.max(0, s + v * h); } }
      S.LV += (TUNE.legK * (Lt - S.L) - LEG_C0 * Math.sqrt(TUNE.legK) * S.LV) * h; S.L += S.LV * h; S.L = Math.min(TUNE.legMax, Math.max(LEG_MIN, S.L)); continue;
    }
    const fs = [endForce(S.sF, S.vF, true), endForce(S.sR, S.vR, false)];
    // frame at each end: spring up, legs' share and its own weight down. Absolute accel; s̈ = −a (wheels on the ground)
    const aF = [0, 1].map(e => (lam[e] * fs[e] - lam[e] * fL - MU_F * lam[e] * G) / (MU_F * lam[e]));
    const aR = (fL - MU_R * G) / MU_R;           // the rider
    S.vF -= aF[0] * h; S.vR -= aF[1] * h; S.sF += S.vF * h; S.sR += S.vR * h;
    S.LV += (lam[0] * aF[0] + lam[1] * aF[1] - aR) * h; S.L += S.LV * h;
    // travel stops: a metal-on-metal bottom-out hands the rest of the hit to the frame (and so the legs)
    if (S.sF > TRAVEL) { S.bottomF = Math.max(S.bottomF, S.vF); S.LV += S.vF * lam[0] * .9; S.sF = TRAVEL; S.vF = 0; }
    if (S.sR > TRAVEL) { S.bottomR = Math.max(S.bottomR, S.vR); S.LV += S.vR * lam[1] * .9; S.sR = TRAVEL; S.vR = 0; }
    if (S.sF < 0) { S.sF = 0; if (S.vF < 0) S.vF = 0; }
    if (S.sR < 0) { S.sR = 0; if (S.vR < 0) S.vR = 0; }
    if (S.L > TUNE.legMax) { S.legHit = Math.max(S.legHit, S.LV); S.L = TUNE.legMax; if (S.LV > 0) { S.vF += S.LV * MU_R; S.vR += S.LV * MU_R; S.LV = 0; } }   // legs out of bend: the body slams the bike
    if (S.L < LEG_MIN) { S.L = LEG_MIN; if (S.LV < 0) S.LV = 0; }
    const N = (lam[0] * fs[0] + lam[1] * fs[1]) / 9.81; load += N / n; pk = Math.max(pk, fL / MU_R / 9.81);
  }
  S.load = o.ground ? load : 0; S.peakG = pk;
  return S;
}
