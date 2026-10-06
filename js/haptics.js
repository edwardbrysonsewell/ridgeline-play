// ───────────────────────── haptics
// Three back ends, best first:
//  1. the native iPhone shell (ios/): Core Haptics through window.RLNative — sharp transients plus a continuous
//     rumble whose intensity and sharpness follow the ground under the tyres;
//  2. Android browsers: navigator.vibrate, with the rumble approximated by a train of short pulses;
//  3. iPhone Safari: since iOS 26.5 a page can't trigger haptics from script at all. The only tick left is a
//     real finger tap on a <label> holding an <input type=checkbox switch>, so the Hop button carries one
//     (see armTapTick) and you feel the pop as you let go.
const NAT = typeof window !== 'undefined' && window.RLNative && window.RLNative.haptics ? window.RLNative : null;
const VIB = !NAT && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

export const HAP = {
  level: 1,                       // 0 off, 1 on, 1.4 strong
  kind: NAT ? 'native' : VIB ? 'vibrate' : 'none',
  _ci: 0, _cs: 0, _sentT: 0, _pulseT: 0, _queue: [],
  // one tap: intensity i and sharpness s, both 0..1
  tap(i, s = .5) {
    i = clamp01(i * this.level); if (i < .02) return;
    if (NAT) NAT.post({ t: 'hap', k: 'transient', i, s: clamp01(s) });
    else if (VIB) { try { navigator.vibrate(Math.round(6 + i * 34)); } catch (e) {} this._pulseT = .06; }
  },
  // a short sequence of taps: [[delay s, i, s], …]
  seq(list) { const now = performance.now() / 1000; for (const [d, i, s] of list) this._queue.push({ t: now + d, i, s }); },
  // continuous rumble, called every frame; only sent when it changes (≤ 30 messages/s)
  rumble(i, s, dt) {
    i = clamp01(i * this.level); s = clamp01(s);
    const now = performance.now() / 1000;
    while (this._queue.length && this._queue[0].t <= now) { const q = this._queue.shift(); this.tap(q.i, q.s); }
    if (NAT) {
      if ((Math.abs(i - this._ci) > .03 || Math.abs(s - this._cs) > .05 || (i === 0 && this._ci !== 0)) && now - this._sentT > 1 / 30) {
        this._ci = i; this._cs = s; this._sentT = now; NAT.post({ t: 'hap', k: 'cont', i, s });
      }
    } else if (VIB) {
      // Android: a pulse train; rougher ground = longer, closer pulses
      this._pulseT -= dt;
      if (i > .06 && this._pulseT <= 0) { this._pulseT = .16 - .1 * i; try { navigator.vibrate(Math.round(4 + i * 16)); } catch (e) {} }
    }
  },
  stop() { this._queue.length = 0; this._ci = 0; if (NAT) NAT.post({ t: 'hap', k: 'stop' }); else if (VIB) { try { navigator.vibrate(0); } catch (e) {} } },
  // iPhone Safari: make a button tick when a real finger lifts off it. The button's own handlers are untouched.
  armTapTick(btn) {
    if (NAT || VIB || !btn || !/iP(hone|ad|od)/.test(navigator.userAgent + (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform) ? 'iPad' : ''))) return;
    const lab = document.createElement('label'); lab.className = 'hapTick'; lab.setAttribute('aria-hidden', 'true');
    const sw = document.createElement('input'); sw.type = 'checkbox'; sw.setAttribute('switch', ''); sw.tabIndex = -1;
    lab.appendChild(sw); btn.appendChild(lab);
    // the label covers the button; its click (a trusted tap) is forwarded to the switch by WebKit, which ticks
    lab.addEventListener('click', e => e.stopPropagation());
    return lab;
  }
};
