// telemetry.js — optional physics read-out for the owner (2026-10-06; Bryson wants to see the physics).
// Off by default; toggled by the "Telemetry" checkboxes (#tel on the title, #tel2 in pause), stored as
// localStorage 'ridgeline.telemetry'. Reads only: game.js calls TEL.frame() once a frame, TEL.bottom() where it
// already pops "Bottomed out", TEL.reset() at the start of a run and TEL.results() when a run finishes.
// Cheap: one small 2D canvas redrawn ~12×/s, sampled every frame into preallocated numbers (no per-frame garbage).
import {store, $} from './core.js';
import {TRAVEL, SAG_F, SAG_R} from './suspension.js';

const BO = .88;                                  // bottom-out zone starts at 88 % of travel (suspension.js)
const LEG_MIN = -.15, LEG_MAX = .38;             // leg range (suspension.js LEG_MIN, TUNE.legMax)
const W = 172, H = 124;                          // overlay size in CSS px
const C = {paper: '#f4efe4', tape: '#ff5f1f', moss: '#b4cf72', slow: '#ff5a4e', line: 'rgba(244,239,228,.22)', bg: 'rgba(14,17,13,.55)'};
const MONO = '"Chivo Mono", ui-monospace, Menlo, Consolas, monospace', BODY = '"Chivo", "Helvetica Neue", Arial, sans-serif';

let on = store.get('telemetry') === true, cv = null, ctx = null, dpr = 1, vis = false, drawT = 0;
// live values (window means/maxes since the last draw) and run totals
const S = {f: 0, r: 0, pkF: 0, pkR: 0, holdF: 0, holdR: 0, legs: 0, gT: 0, gR: 0, slope: 0, grip: 0, spd: 0, n: 0, air: false,
  lastAir: 0, lastVn: 0, landT: -1, bot: 0, botF: 0, botR: 0};
const histF = new Float64Array(10), histR = new Float64Array(10);
let gT = 0, sumF = 0, sumR = 0;                  // grounded time and travel·time sums for the averages

function ensure() {
  if (cv) return;
  cv = document.createElement('canvas'); cv.id = 'telemetry'; cv.hidden = true;
  dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = W * dpr; cv.height = H * dpr;
  cv.style.cssText = `position:fixed;left:calc(env(safe-area-inset-left,0px) + 150px);top:calc(env(safe-area-inset-top,0px) + 84px);width:${W}px;height:${H}px;pointer-events:none;border-radius:6px;z-index:2`;
  document.body.appendChild(cv); ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
}
function setOn(v) {
  on = !!v; store.set('telemetry', on);
  for (const id of ['tel', 'tel2']) { const e = $(id); if (e) e.checked = on; }
  if (!on && cv) { cv.hidden = true; vis = false; }
  const r = $('telRes'); if (r && !on) r.hidden = true;
}
for (const id of ['tel', 'tel2']) { const e = $(id); if (e) { e.checked = on; e.addEventListener('change', ev => setOn(ev.target.checked)); } }

function reset() {
  histF.fill(0); histR.fill(0); gT = sumF = sumR = 0;
  S.bot = S.botF = S.botR = 0; S.lastAir = 0; S.lastVn = 0; S.pkF = S.pkR = 0; S.landT = -1;
  const r = $('telRes'); if (r) r.hidden = true;
}
function bottom(SS) { S.bot++; if (SS.sF >= SS.sR) S.botF++; else S.botR++; }

// state: game state string; P: the rider/bike state; SS: the suspension state (game.js reassigns it on respawn)
function frame(rdt, state, P, SS) {
  const want = on && (state === 'ride' || state === 'crash' || state === 'countdown');
  if (want !== vis) { ensure(); cv.hidden = !want; vis = want; }
  if (!want) return;
  const f = P.sF / TRAVEL, r = P.sR / TRAVEL;
  // peak hold: hold 0.8 s, then fall at 40 % of travel per second
  if (f >= S.pkF) { S.pkF = f; S.holdF = .8; } else if ((S.holdF -= rdt) < 0) S.pkF = Math.max(f, S.pkF - .4 * rdt);
  if (r >= S.pkR) { S.pkR = r; S.holdR = .8; } else if ((S.holdR -= rdt) < 0) S.pkR = Math.max(r, S.pkR - .4 * rdt);
  S.f += f; S.r += r; S.legs += P.legs || 0; S.gT += SS.load || 0; S.gR = Math.max(S.gR, SS.peakG || 0);
  S.grip += P.gripUse || 0; S.spd += P.spd || 0; S.n++;
  S.air = !P.ground; if (P.ground) S.slope += Math.acos(Math.min(1, P.cosA || 1));
  if ((P.lastLandT ?? -1) !== S.landT) { S.landT = P.lastLandT; if ((P.lastAir || 0) > .15) { S.lastAir = P.lastAir; S.lastVn = P.lastVn || 0; } }
  if (state === 'ride' && P.ground && rdt > 0) {           // travel histogram: grounded riding time only
    histF[Math.min(9, f * 10 | 0)] += rdt; histR[Math.min(9, r * 10 | 0)] += rdt; gT += rdt; sumF += f * rdt; sumR += r * rdt;
  }
  drawT += rdt; if (drawT < .08) return; drawT = 0;
  draw(); S.f = S.r = S.legs = S.gT = S.gR = S.grip = S.spd = S.slope = 0; S.n = 0;
}

function bar(x, y, w, h, v, pk, sag, label) {        // vertical travel bar
  const g = ctx;
  g.fillStyle = C.line; g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(255,90,78,.35)'; g.fillRect(x, y, w, h * (1 - BO));             // bottom-out zone (top 12 %)
  const vv = Math.min(1, Math.max(0, v));
  g.fillStyle = vv > BO ? C.slow : C.tape; g.fillRect(x, y + h * (1 - vv), w, h * vv);
  g.fillStyle = C.paper; g.fillRect(x - 3, y + h * (1 - sag) - .5, w + 6, 1.5);        // sag tick
  g.fillStyle = C.moss; g.fillRect(x, y + h * (1 - Math.min(1, pk)) - 1, w, 2);       // peak hold
  g.font = `700 8px ${BODY}`; g.textAlign = 'center'; g.fillStyle = C.paper; g.fillText(label, x + w / 2, y - 4);
  g.font = `700 10px ${MONO}`; g.fillText(Math.round(vv * TRAVEL * 1000), x + w / 2, y + h + 11);
  g.globalAlpha = .7; g.fillText(Math.round(vv * 100) + '%', x + w / 2, y + h + 22); g.globalAlpha = 1;
}
function row(y, lbl, val, col) {
  const g = ctx; g.textAlign = 'left'; g.font = `700 8px ${BODY}`; g.fillStyle = C.paper; g.globalAlpha = .65; g.fillText(lbl, 66, y); g.globalAlpha = 1;
  g.textAlign = 'right'; g.font = `700 11px ${MONO}`; g.fillStyle = col || C.paper; g.fillText(val, W - 6, y);
}
function hbar(y, v, max, zero, col) {               // thin horizontal bar under a row; zero = where 0 sits (0..1)
  const g = ctx, x = 66, w = W - 72; g.fillStyle = C.line; g.fillRect(x, y, w, 3);
  const a = x + w * zero, b = x + w * Math.min(1, Math.max(0, zero + v / max));
  g.fillStyle = col; g.fillRect(Math.min(a, b), y, Math.abs(b - a), 3);
  if (zero > 0) { g.fillStyle = C.paper; g.fillRect(a - .5, y - 1, 1, 5); }
}
function draw() {
  const g = ctx, n = Math.max(1, S.n);
  g.clearRect(0, 0, W, H); g.fillStyle = C.bg; g.beginPath(); g.roundRect ? g.roundRect(0, 0, W, H, 6) : g.rect(0, 0, W, H); g.fill();
  bar(9, 16, 14, 72, S.f / n, S.pkF, SAG_F / TRAVEL, 'FORK');
  bar(41, 16, 14, 72, S.r / n, S.pkR, SAG_R / TRAVEL, 'SHOCK');
  const L = S.legs / n, gr = S.grip / n;
  row(13, 'LEGS', (L >= 0 ? '+' : '−') + Math.abs(L).toFixed(2) + ' m'); hbar(16, L, LEG_MAX - LEG_MIN, -LEG_MIN / (LEG_MAX - LEG_MIN), C.paper);
  row(31, 'LOAD', S.air ? 'air' : (S.gT / n).toFixed(2) + ' g', (S.gT / n) > 2.5 ? C.slow : null);
  row(43, 'RIDER', S.gR.toFixed(2) + ' g');
  row(55, 'SLOPE', S.air ? '—' : Math.round(S.slope / n * 57.2958) + '°');
  row(67, 'GRIP', Math.round(gr * 100) + '%', gr > 1 ? C.slow : null); hbar(70, gr, 1.2, 0, gr > 1 ? C.slow : gr > .8 ? C.tape : C.moss);
  row(85, 'SPEED', (S.spd / n * 3.6).toFixed(1));
  row(97, 'AIR', S.lastAir ? S.lastAir.toFixed(2) + ' s' : '—');
  row(109, 'IMPACT', S.lastAir ? S.lastVn.toFixed(1) + ' m/s' : '—', S.lastVn > 6 ? C.slow : null);
  row(121, 'BOTTOM', String(S.bot), S.bot ? C.slow : null);
}

// end of a run: travel histogram (share of grounded time in each 10 % of travel), front and rear
function results() {
  const box = $('telRes'); if (!box) return;
  box.hidden = !on || gT < .5; if (box.hidden) return;
  const c = $('telHist'), w = 300, h = 88, d = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== w * d) { c.width = w * d; c.height = h * d; }
  const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h);
  let mx = .01; for (let i = 0; i < 10; i++) mx = Math.max(mx, histF[i] / gT, histR[i] / gT);
  const x0 = 4, bw = (w - 8) / 10, top = 12, bh = h - top - 14;
  g.fillStyle = 'rgba(180,207,114,.26)'; g.fillRect(x0 + bw * 2.5, top - 2, bw * 1.5, bh + 2);   // WC average 25–40 %
  g.fillStyle = 'rgba(255,90,78,.18)'; g.fillRect(x0 + bw * 8.8, top - 2, bw * 1.2, bh + 2);   // bottom-out zone
  for (let i = 0; i < 10; i++) {
    const a = histF[i] / gT, b = histR[i] / gT, bx = x0 + i * bw;
    g.fillStyle = C.paper; g.fillRect(bx + 2, top + bh * (1 - a / mx), bw / 2 - 3, bh * a / mx);
    g.fillStyle = C.tape; g.fillRect(bx + bw / 2 + 1, top + bh * (1 - b / mx), bw / 2 - 3, bh * b / mx);
    g.fillStyle = C.paper; g.globalAlpha = .6; g.font = `700 9px ${MONO}`; g.textAlign = 'center';
    g.fillText(i * 10 + '', bx + bw / 2, h - 2); g.globalAlpha = 1;
  }
  g.fillStyle = C.line; g.fillRect(x0, top + bh, w - 8, 1);
  g.font = `700 9px ${MONO}`; g.textAlign = 'left'; g.fillStyle = C.paper; g.fillText('% of travel →   peak bin ' + Math.round(mx * 100) + '% of time', x0, 9);
  $('telAvg').textContent = Math.round(sumF / gT * 100) + '% / ' + Math.round(sumR / gT * 100) + '%';
  $('telBot').textContent = S.bot + (S.bot ? ' (F ' + S.botF + ' · R ' + S.botR + ')' : '');
}

export const TEL = {get on() { return on; }, setOn, reset, bottom, frame, results};
