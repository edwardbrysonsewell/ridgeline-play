// ───────────────────────── Ridgeline audio — procedural Web Audio, no files
// One bounded node graph is built in init(). update(s) (every frame) only moves AudioParams, and the textured
// transients (gravel grains, twig ticks, rock clatter, plank knocks, chain slap, suspension thuds) are scheduled
// ~0.12 s ahead onto a small pool of persistent "voices" (noise → envelope gain → resonant filter) instead of
// creating nodes. Discrete events create at most a few short-lived nodes each, rate-limited by a token bucket.
// The freehub is an impulse-train oscillator (one click per pawl engagement) through hub-shell resonances.
// Everything ends in a gentle compressor and a soft clipper whose ceiling is below 0 dBFS.

const LA=.12;                       // scheduler look-ahead, s
const POE=44;                       // freehub engagement points (loud DH hub)
const VOICE_RATE=20,VOICE_BURST=10; // node-creating event voices per second / burst
const fin=(v,d=0)=>Number.isFinite(v)?v:d;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const rnd=(a,b)=>a+Math.random()*(b-a);
const sstep=x=>{x=clamp(x,0,1);return x*x*(3-2*x);};

// mix levels (linear); calibrated with tools/audio_test.mjs
const M={rumble:.2,dirt:.25,grass:.2,forest:.4,rock:.32,wood:.7,skid:.55,
 wind:.16,buffet:.3,whistle:.03,whoosh:.2,hub:8,squeal:.07,pad:.12,drive:.05,
 grit:2.2,knock:.9,body:3,thud:.45,metal:.07,ev:1,tree:.6};

export const SFX={on:true,ctx:null,mix:M,  // mix: live level table, tweakable at runtime

 // init(ctx?) — lazily creates the AudioContext (call from a user gesture). An injected context (e.g. an
 // OfflineAudioContext for tests) replaces the current one. Returns true when audio is available.
 init(ctx){
  if(this.ctx&&(!ctx||ctx===this.ctx))return true;
  try{const C=globalThis.AudioContext||globalThis.webkitAudioContext;const c=ctx||new C();
   this.ctx=c;this._build(c);
   if(!ctx){try{const b=c.createBuffer(1,1,c.sampleRate),s=c.createBufferSource();s.buffer=b;s.connect(c.destination);s.start(0);}catch(_){}
    this.resume();}
   return true;
  }catch(e){this.ctx=null;this._L=null;return false;}},

 resume(){const c=this.ctx;if(!c||typeof c.startRendering==='function')return;
  try{if(c.state!=='running'){const p=c.resume();if(p&&p.catch)p.catch(()=>{});}}catch(_){}},

 _build(c){
  const sr=c.sampleRate;this._fmax=sr*.45;
  const buf=(sec,fill)=>{const b=c.createBuffer(1,Math.floor(sr*sec),sr),d=b.getChannelData(0);fill(d);return b;};
  // loop-safe coloured noise: remove the end-to-start step, then normalise
  const fit=d=>{const n=d.length,s=d[n-1]-d[0];let m=0;for(let i=0;i<n;i++){d[i]-=s*i/(n-1);m=Math.max(m,Math.abs(d[i]));}
   const k=.9/(m||1);for(let i=0;i<n;i++)d[i]*=k;};
  const white=this.noise=buf(2.3,d=>{for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;});
  const pink=buf(3.7,d=>{let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;for(let i=0;i<d.length;i++){const w=Math.random()*2-1;
   b0=.99886*b0+w*.0555179;b1=.99332*b1+w*.0750759;b2=.969*b2+w*.153852;b3=.8665*b3+w*.3104856;b4=.55*b4+w*.5329522;b5=-.7616*b5-w*.016898;
   d[i]=b0+b1+b2+b3+b4+b5+b6+w*.5362;b6=w*.115926;}fit(d);});
  const brown=buf(4.1,d=>{let v=0;for(let i=0;i<d.length;i++){v=v*.997+.03*(Math.random()*2-1);d[i]=v;}fit(d);});
  const loop=(b,r)=>{const s=c.createBufferSource();s.buffer=b;s.loop=true;s.playbackRate.value=r;s.start(0,Math.random()*b.duration*.9);return s;};
  const nW1=loop(white,1),nW2=loop(white,.93),nP=loop(pink,1),nB=loop(brown,1);
  this._buf={white,pink,brown};
  const filt=(type,f,q)=>{const b=c.createBiquadFilter();b.type=type;b.frequency.value=f;b.Q.value=q;return b;};
  const gain=(v=0)=>{const g=c.createGain();g.gain.value=v;return g;};
  const chain=(...n)=>{for(let i=0;i<n.length-1;i++)n[i].connect(n[i+1]);return n[0];};

  // master: buses → mix → compressor → ×½ → soft clipper (unity below ±0.8, ceiling 0.99) → on/off gain → out
  const mix=gain(.9),comp=c.createDynamicsCompressor();
  comp.threshold.value=-15;comp.knee.value=12;comp.ratio.value=3;comp.attack.value=.004;comp.release.value=.2;
  const pre=gain(.5),sh=c.createWaveShaper(),N=2048,cv=new Float32Array(N);
  for(let i=0;i<N;i++){const y=(i/(N-1)*2-1)*2,a=Math.abs(y);cv[i]=a<.8?y:Math.sign(y)*(.8+.19*Math.tanh((a-.8)/.19));}
  sh.curve=cv;sh.oversample='none';
  const out=this.master=gain(this.on?1:0);
  chain(mix,comp,pre,sh,out,c.destination);
  const bus=this.bus={tyre:gain(1),wind:gain(1),mech:gain(1),ev:gain(1),ui:gain(1)};
  for(const k in bus)bus[k].connect(mix);

  // continuous layers: noise → filter → gain
  const L=this._L={};
  const lay=(name,src,type,f,q,dst)=>{const l=L[name]={f:filt(type,f,q),g:gain()};chain(src,l.f,l.g,dst);};
  lay('rumble',nB,'lowpass',150,.9,bus.tyre);    // tyre/frame rumble (sub + low-mid)
  lay('rumbleHi',nP,'bandpass',260,1.1,bus.tyre); // the part of it a phone speaker can reproduce
  lay('dirt',nW1,'bandpass',1700,.75,bus.tyre);   // loose-dirt crunch hiss
  lay('grass',nW2,'bandpass',4200,.6,bus.tyre);   // grass swish
  lay('forest',nP,'lowpass',520,.8,bus.tyre);     // loam: dull
  lay('rock',nW2,'bandpass',1100,1.2,bus.tyre);   // hard rolling whirr under the clatter
  lay('wood',nP,'bandpass',330,2.5,bus.tyre);     // hollow deck roll
  lay('skid',nW1,'bandpass',1000,1.3,bus.tyre);   // tyre scrub
  lay('wind',nP,'lowpass',600,.5,bus.wind);
  lay('buffet',nB,'lowpass',260,1,bus.wind);      // helmet buffeting (modulated per frame)
  lay('whistle',nW1,'bandpass',900,14,bus.wind);  // helmet vents
  lay('whoosh',nW2,'bandpass',1500,.7,bus.wind);  // clean air-time rush
  lay('pad',nW2,'bandpass',4200,1.5,bus.mech);    // pad friction hiss
  lay('drive',nW1,'bandpass',2600,2,bus.mech);    // chain over cogs while pedalling

  // freehub: impulse train at wheelHz×POE → hub-shell resonances. The wave is peak-normalised, so a click's
  // peak falls ~1/rate; update() scales gain ~rate^0.75 to keep every click about equally loud, as on a real hub.
  const H=1024,re=new Float32Array(H),im=new Float32Array(H);for(let i=1;i<H;i++)re[i]=1;
  const fo=c.createOscillator();fo.setPeriodicWave(c.createPeriodicWave(re,im));fo.frequency.value=100;
  const fhp=filt('highpass',1400,.7),fb1=filt('bandpass',3300,2.5),fb2=filt('bandpass',6200,5),fg=gain();
  fo.connect(fhp);fhp.connect(fb1);fhp.connect(fb2);fb1.connect(fg);fb2.connect(fg);fg.connect(bus.mech);fo.start();
  L.hub={o:fo,g:fg};

  // brake rotor howl: two inharmonic partials with vibrato
  const b1=c.createOscillator(),b2=c.createOscillator(),lfo=c.createOscillator(),lg=gain(10),bg=gain(),b2g=gain(.4);
  b1.frequency.value=1250;b2.frequency.value=2330;lfo.frequency.value=5.7;
  lfo.connect(lg);lg.connect(b1.frequency);lg.connect(b2.frequency);b1.connect(bg);b2.connect(b2g);b2g.connect(bg);bg.connect(bus.mech);
  b1.start();b2.start();lfo.start();
  L.squeal={o1:b1,o2:b2,lfo,depth:lg,g:bg};

  // voice pools (persistent; envelopes scheduled on their params)
  const grit=[];for(let i=0;i<3;i++){const v={g:gain(),f:filt('bandpass',2000,2),last:0};chain(i%2?nW2:nW1,v.g,v.f,bus.tyre);grit.push(v);}
  const kb=gain(1),kd=gain(.6),bodyG=gain(M.body),bo1=filt('bandpass',230,10),bo2=filt('bandpass',390,8);
  kb.connect(kd);kd.connect(bus.tyre);kb.connect(bo1);kb.connect(bo2);bo1.connect(bodyG);bo2.connect(bodyG);bodyG.connect(bus.tyre);
  const knock=[];for(let i=0;i<2;i++){const v={g:gain(),f:filt('bandpass',600,2),last:0};chain(i?nW2:nW1,v.g,v.f,kb);knock.push(v);}
  const metal=[];for(let i=0;i<2;i++){const o1=c.createOscillator(),o2=c.createOscillator(),mg=gain(),ng=gain(),nf=filt('bandpass',3000,3);
   o1.connect(mg);o2.connect(mg);mg.connect(bus.mech);chain(i?nW2:nW1,ng,nf,bus.mech);o1.start();o2.start();
   metal.push({o1,o2,mg,ng,nf,last:0});}
  const thud=[];for(let i=0;i<2;i++){const o=c.createOscillator();o.type='triangle';o.frequency.value=60;const og=gain(),ng=gain(),nf=filt('lowpass',380,.8);
   o.connect(og);og.connect(bus.mech);chain(nP,ng,nf,bus.mech);o.start();thud.push({o,og,ng,nf,last:0});}
  this._P={grit,knock,metal,thud,gi:0,ki:0};

  // state
  this._gG={t:0};this._gK={t:0,w:0};this._live=false;this._spd=0;this._sw=[1,0,0,0];this._wood=false;
  this._sv=0;this._thT=0;this._csT=0;this._gust=0;this._swish=0;this._sq=.5;this._tok=VOICE_BURST;this._tokT=0;this._treeT=0;
 },

 // smoothed param set; ignores non-finite values and skips no-op updates
 _s(p,v,tc=.05){if(!Number.isFinite(v)||!Number.isFinite(tc)||tc<=0)return;
  if(p.__v!==undefined&&Math.abs(p.__v-v)<=1e-5*(1+Math.abs(v)))return;p.__v=v;
  try{p.setTargetAtTime(v,this.ctx.currentTime,tc);}catch(_){}},
 _f(v){return clamp(fin(v,1000),20,this._fmax);},

 update(s){
  const c=this.ctx,L=this._L;if(!c||!L||!s)return;
  const now=c.currentTime,dt=clamp(fin(s.dt,1/60),.004,.1);
  const on=!!this.on;this._s(this.master.gain,on?1:0,.03);
  const live=on&&!!s.live;this._live=!!s.live;const m=live?1:0;
  const spd=clamp(fin(s.spd),0,60),ground=!!s.ground,air=clamp(fin(s.air),0,30),helmet=!!s.helmet;
  const sw=[1,0,0,0],si=s.surf;
  if(si&&si.length>=4){let t=0;for(let i=0;i<4;i++){sw[i]=clamp(fin(si[i]),0,1);t+=sw[i];}if(t>1e-6)for(let i=0;i<4;i++)sw[i]/=t;else sw[0]=1;}
  const wood=!!s.wood&&ground,narrow=wood&&!!s.narrow;
  const rough=clamp(fin(s.rough),0,1),skid=clamp(fin(s.skid),0,1),brake=clamp(fin(s.brake),0,1);
  const lean=clamp(fin(s.lean),-1,1),wheelHz=clamp(fin(s.wheelHz),0,40),suspV=clamp(fin(s.suspV),-30,30);
  this._spd=spd;this._sw=sw;this._wood=wood;
  const B=this.bus;this._s(B.tyre.gain,helmet?.85:1,.1);this._s(B.mech.gain,helmet?.9:1,.1);

  // ── tyres
  const g=ground?m:0,sp=Math.min(1,spd/14),soil=wood?0:1;
  const load=(1+.35*Math.abs(lean)+(s.pumping?.25:0))*g;
  this._swish=clamp(this._swish+(Math.random()-.5)*dt*6-this._swish*dt*2,-.5,.5);
  const rumK=load*Math.pow(sp,1.2)*(.45+rough*1.3)*(wood?.55:(.6*sw[1]+1*sw[0]+.9*sw[2]+1.35*sw[3]));
  this._s(L.rumble.g.gain,M.rumble*rumK*(1+Math.min(1,Math.abs(suspV))*.6),.04);
  this._s(L.rumble.f.frequency,clamp(90+spd*9,60,320));
  this._s(L.rumbleHi.g.gain,M.rumble*rumK,.04);
  this._s(L.dirt.g.gain,M.dirt*load*soil*sw[0]*Math.pow(sp,1.5)*(1+rough*.5),.05);
  this._s(L.dirt.f.frequency,this._f(1300+spd*60+Math.abs(lean)*500));
  this._s(L.grass.g.gain,M.grass*load*soil*sw[1]*Math.pow(sp,1.3)*(1+this._swish),.06);
  this._s(L.grass.f.frequency,this._f(3600+spd*90));
  this._s(L.forest.g.gain,M.forest*load*soil*sw[2]*sp,.05);
  this._s(L.rock.g.gain,M.rock*load*soil*sw[3]*sp*(.6+rough),.05);
  this._s(L.wood.g.gain,M.wood*load*(wood?1:0)*Math.min(1,spd/8)*(narrow?1.4:1),.05);
  this._s(L.wood.f.frequency,narrow?240:330);
  const skF=wood?1500:900*sw[0]+2300*sw[1]+550*sw[2]+2600*sw[3];
  this._s(L.skid.g.gain,M.skid*g*Math.pow(skid,1.2)*Math.min(1,spd/3)*(wood?.8:1),.04);
  this._s(L.skid.f.frequency,this._f(skF*(.9+.2*skid)));
  this._skF=skF;

  // ── wind
  this._gust=clamp(this._gust+(Math.random()-.5)*dt*1.4-this._gust*dt*.35,-.4,.4);
  const gust=1+this._gust,w=Math.min(1.8,(spd/18)**2);
  this._s(L.wind.g.gain,m*M.wind*w*gust*(helmet?2:1),.08);
  this._s(L.wind.f.frequency,this._f((helmet?260:340)+spd*(helmet?75:45)*(.85+.3*gust)),.1);
  this._s(L.buffet.g.gain,helmet?m*M.buffet*w*gust*rnd(.25,1.45)*(ground?1:.45):0,.025);
  this._s(L.buffet.f.frequency,clamp(180+spd*6,100,400));
  this._s(L.whistle.g.gain,helmet?m*M.whistle*sstep((spd-6)/14)*gust:0,.15);
  this._s(L.whistle.f.frequency,this._f(650+spd*30+this._gust*120),.2);
  const inAir=!ground&&air>.06;
  this._s(L.whoosh.g.gain,inAir?m*M.whoosh*Math.pow(sp,1.5)*Math.min(1,(air-.06)/.2):0,.06);
  this._s(L.whoosh.f.frequency,this._f(900+spd*70));

  // ── drivetrain
  const coast=!!s.coast&&!s.pedal;
  this._s(L.hub.g.gain,m*(coast&&wheelHz>.15?1:0)*M.hub*Math.min(1.3,Math.pow(Math.max(1,wheelHz*POE)/220,.75))*rnd(.8,1.2),coast?.012:.03);
  this._s(L.hub.o.frequency,clamp(wheelHz*POE,1,3000),.02);
  this._s(L.drive.g.gain,m*(s.pedal?1:0)*Math.min(1,spd/6)*M.drive,.06);

  // ── brakes: howl comes in bouts and wanders in pitch
  this._sq=clamp(this._sq+(Math.random()-.5)*dt*1.5,0,1);
  const sqOn=ground&&brake>.45&&spd>2.5;
  this._s(L.squeal.g.gain,sqOn?m*M.squeal*sstep((brake-.45)/.45)*Math.min(1,(spd-2.5)/6)*(.3+.7*this._sq):0,sqOn?.06:.03);
  const f1=1150+650*this._sq+(Math.random()-.5)*30;
  this._s(L.squeal.o1.frequency,this._f(f1),.04);this._s(L.squeal.o2.frequency,this._f(f1*1.86),.04);
  this._s(L.squeal.depth.gain,6+22*this._sq,.1);
  this._s(L.pad.g.gain,m*g*brake*Math.min(1,spd/10)*M.pad,.04);

  // ── scheduled transients: surface grains / clatter, or plank knocks
  if(g&&!wood&&spd>.4){
   const d=[sw[0]*spd*(4.5+6*skid),sw[1]*spd*1.2,sw[2]*spd*2.6,sw[3]*spd*(3+16*rough)];
   const tot=d[0]+d[1]+d[2]+d[3],rate=Math.min(170,tot),amp=M.grit*Math.pow(Math.min(1,spd/10),.7);
   this._gen(this._gG,now,rate,false,t=>{let r=Math.random()*tot,k=0;while(k<3&&r>d[k]){r-=d[k];k++;}this._grain(k,t,amp,rough,skid);});
  }else this._gG.t=0;
  if(g&&wood&&spd>.3){
   const per=Math.min(45,spd/(narrow?2.4:.14));  // per wheel; above ~45/s the hollow roll carries it
   const amp=M.knock*(narrow?1.4:1)*(.55+.45*Math.min(1,spd/6))*(per>30?.75:1);
   this._gen(this._gK,now,per*2,true,t=>{const rear=(this._gK.w^=1);
    this._knock(t,amp*(rear?1:.8)*rnd(.75,1.1),narrow?rnd(280,420):rnd(480,900),narrow?.018:.007);});
  }else this._gK.t=0;

  // ── suspension: thuds on hits, chain slap on rough ground
  const dv=Math.abs(suspV-this._sv)*(1/60)/dt;this._sv=suspV;
  if(g){
   if(dv>.3&&now>this._thT){const k=clamp((dv-.3)/.9,0,1);if(Math.random()<.35+.65*k){this._thud(now+.004,.12+.4*k,rnd(105,135),rnd(45,60),.05+.07*k);this._thT=now+.08;}}
   if(dv>.22&&rough>.15&&now>this._csT){const k=clamp((dv-.22)/.6,0,1);
    if(Math.random()<(coast?.55:.3)*(.3+.7*k)){this._chain(now+.004,.4+.6*k);this._csT=now+.11;}}
  }
 },

 // generator: Poisson (or jittered-periodic) onsets scheduled into [now, now+LA]
 _gen(G,now,rate,periodic,fn){
  if(!(rate>.5)){G.t=0;return;}
  if(G.t<now+.004)G.t=now+.004+Math.random()/rate*.5;
  let n=0;const end=now+LA;
  while(G.t<end&&n++<32){fn(G.t);G.t+=periodic?(1+(Math.random()-.5)*.25)/rate:-Math.log(1-Math.random()*.999)/rate;}
 },
 _pick(pool){let v=pool[0];for(const u of pool)if(u.last<v.last)v=u;return v;},
 _env(p,t,a,tc,last){if(t<last)p.cancelScheduledValues(t);p.setValueAtTime(a,t);p.setTargetAtTime(0,t+.0004,tc);},

 // one surface grain: 0 dirt, 1 grass, 2 forest (twig tick / root thunk), 3 rock clatter
 _grain(k,t,amp,rough,skid){
  const P=this._P,v=P.grit[P.gi=(P.gi+1)%P.grit.length];let a,f,q,tc;
  if(k===0){a=rnd(.08,.3)*(1+skid*.8);f=rnd(1400,4200);q=rnd(1.2,3);tc=rnd(.002,.006);}
  else if(k===1){a=rnd(.05,.12);f=rnd(3500,7000);q=1;tc=rnd(.004,.01);}
  else if(k===2){if(Math.random()<.8){a=rnd(.1,.35);f=rnd(2500,6000);q=rnd(4,8);tc=rnd(.0015,.004);}else{a=rnd(.3,.6);f=rnd(250,500);q=2.5;tc=rnd(.01,.02);}}
  else{a=(.1+.9*Math.random()**3)*(.35+.8*rough);if(Math.random()<.2){f=rnd(400,800);q=3;tc=rnd(.01,.02);}else{f=rnd(1200,5200);q=rnd(3,10);tc=rnd(.003,.012);}}
  this._hit(v,t,a*amp,f,q,tc);
 },
 _hit(v,t,a,f,q,tc){
  if(t<v.last){v.f.frequency.cancelScheduledValues(t);v.f.Q.cancelScheduledValues(t);}
  v.f.frequency.setValueAtTime(this._f(f),t);v.f.Q.setValueAtTime(q,t);this._env(v.g.gain,t,fin(a),tc,v.last);v.last=t;
 },
 _knock(t,a,f,tc){const P=this._P;this._hit(P.knock[P.ki=(P.ki+1)%P.knock.length],t,a,f,2,tc);},
 _thud(t,a,f0,f1,tc){
  const v=this._pick(this._P.thud);a=clamp(fin(a),0,1.5)*M.thud;
  if(t<v.last){v.o.frequency.cancelScheduledValues(t);v.og.gain.cancelScheduledValues(t);v.ng.gain.cancelScheduledValues(t);}
  v.o.frequency.setValueAtTime(this._f(f0),t);v.o.frequency.setTargetAtTime(this._f(f1),t,.05);
  v.og.gain.setValueAtTime(0,t);v.og.gain.linearRampToValueAtTime(a,t+.005);v.og.gain.setTargetAtTime(0,t+.005,tc);
  v.ng.gain.setValueAtTime(a*.7,t);v.ng.gain.setTargetAtTime(0,t+.0004,tc*.5);v.last=t;
 },
 // metallic hit: two inharmonic partials + a filtered noise click
 _metal(t,f,ratio,a,tc,an=a*.6,nf=f*1.4){
  const v=this._pick(this._P.metal);
  if(t<v.last){v.o1.frequency.cancelScheduledValues(t);v.o2.frequency.cancelScheduledValues(t);v.nf.frequency.cancelScheduledValues(t);}
  v.o1.frequency.setValueAtTime(this._f(f),t);v.o2.frequency.setValueAtTime(this._f(f*ratio),t);v.nf.frequency.setValueAtTime(this._f(nf),t);
  this._env(v.mg.gain,t,fin(a)*M.metal,tc,v.last);this._env(v.ng.gain,t,fin(an)*M.metal,.004,v.last);v.last=t;
 },
 _chain(t,k){this._metal(t,rnd(2200,2600),rnd(1.48,1.58),.6*k,rnd(.035,.06),.9*k,rnd(3500,5000));},

 // short-lived noise voice; throttled unless forced
 _take(force){const now=this.ctx.currentTime;this._tok=Math.min(VOICE_BURST,this._tok+(now-this._tokT)*VOICE_RATE);this._tokT=now;
  if(this._tok>=1){this._tok-=1;return true;}return !!force;},
 _burst(o){
  const c=this.ctx;if(!this._take(o.force))return;
  const t=c.currentTime+(o.when||0)+.005,dur=Math.max(.02,fin(o.dur,.2)),att=clamp(fin(o.att,.004),.001,dur*.9);
  const src=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();
  src.buffer=this._buf[o.buf||'white'];f.type=o.type||'bandpass';f.Q.value=fin(o.q,1);
  f.frequency.setValueAtTime(this._f(o.f0),t);f.frequency.exponentialRampToValueAtTime(this._f(o.f1||o.f0),t+dur);
  g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(clamp(fin(o.a),0,2)*M.ev,t+att);g.gain.setTargetAtTime(0,t+att,(dur-att)/4);
  src.connect(f);f.connect(g);let last=g;
  if(o.pan!==undefined&&c.createStereoPanner){const p=c.createStereoPanner(),p0=clamp(fin(o.pan0,o.pan),-1,1);
   p.pan.setValueAtTime(p0,t);p.pan.linearRampToValueAtTime(clamp(fin(o.pan),-1,1),t+att);g.connect(p);last=p;}
  last.connect(o.bus||this.bus.ev);
  src.start(t,Math.random()*Math.max(0,src.buffer.duration-dur-.1));src.stop(t+dur+.05);
  src.onended=()=>{try{last.disconnect();}catch(_){}};
 },

 event(name,k=1,opt={}){
  const c=this.ctx;if(!c||!this._L||!this.on)return;
  if(name!=='crash'&&name!=='finish'&&name!=='gate'&&!this._live)return;
  k=clamp(fin(k,1),0,1);opt=opt||{};const t=c.currentTime+.005,spd=this._spd;
  switch(name){
   case 'land':{
    this._thud(t,.35+.6*k,rnd(110,130),rnd(42,52),.12+.18*k);
    this._burst({type:'lowpass',f0:2400,f1:260,q:.8,a:.15+.4*k,att:.004,dur:.16+.12*k});   // tyre squash
    this._chain(t+.015,.5+.5*k);
    for(let i=0,n=1+Math.round(4*k);i<n;i++)this._metal(t+rnd(.03,.24),rnd(1700,4200),rnd(1.3,1.7),(.2+.6*k)*rnd(.5,1),rnd(.02,.05));
    if(this._wood)this._knock(t+.002,M.knock*(1+k),rnd(300,420),.03);
    if(k>.85)this._metal(t+.01,760,1.71,1.4,.07);
    break;}
   case 'hop':
    this._thud(t,.15+.15*k,rnd(130,150),70,.07);
    this._burst({type:'bandpass',f0:1600,f1:900,q:1,a:.1+.1*k,att:.003,dur:.09});
    this._chain(t+.03,.35+.3*k);break;
   case 'bottom':
    this._thud(t,1,95,40,.2);this._metal(t,760,1.71,1.6,.07,1.2,1500);this._metal(t+.006,1650,2.2,.7,.05);break;
   case 'crash':{
    this._thud(t,1,110,40,.3);
    this._burst({type:'lowpass',f0:900,f1:200,q:.7,a:.7,att:.004,dur:.35,force:true});                // body impact
    this._burst({type:'bandpass',f0:1300,f1:420,q:.7,a:.35,att:.05,dur:1.4,force:true});              // sliding debris
    this._burst({type:'highpass',f0:3200,f1:1800,q:.7,a:.18,att:.01,dur:.55,force:true,when:.08});    // gravel spray
    [.22,.48,.75,1.05].forEach((d,i)=>this._thud(t+d+rnd(0,.05),.75*(1-i*.2),rnd(90,120),45,.14));
    for(let i=0;i<7;i++){const d=rnd(.05,1.25);this._metal(t+d,rnd(900,3500),rnd(1.3,2.4),(1.5-d)*rnd(.4,.9),rnd(.03,.09));}
    break;}
   case 'log':{
    const dtR=clamp(1.3/Math.max(spd,1),.05,.6);
    this._thud(t,.45*(.5+k*.5),130,60,.12);this._knock(t,.6*(.5+k*.5),rnd(380,460),.02);
    this._thud(t+dtR,.4*(.5+k*.5),125,55,.12);this._knock(t+dtR,.5*(.5+k*.5),rnd(380,460),.02);
    this._chain(t+dtR+.01,.6);break;}
   case 'rock':
    this._metal(t,rnd(1900,2600),1.6,.4+.8*k,.012,1.4+1.6*k,rnd(2500,3500));     // stone clack
    if(k>.55)this._metal(t+.002,rnd(1050,1250),2.76,.6*k,.22,0);                      // rim ping
    this._thud(t,.15+.35*k,140,70,.08);break;
   case 'treePass':{
    if(t<this._treeT)return;this._treeT=t+.06;
    const pan=clamp(fin(opt.pan),-1,1),dur=.32-.12*k;
    this._burst({type:'bandpass',f0:1800+1400*k,f1:500+300*k,q:1.1,a:M.tree*(.15+.6*Math.pow(k,1.3)),att:dur*.42,dur,pan,pan0:pan*.35});
    break;}
   case 'gate':this.chime();break;
   case 'finish':this.chime();this.tone(1976,.9,.12,'sine',.2);break;
   case 'dab':this._thud(t,.3,150,80,.07);this._burst({type:'lowpass',f0:1100,f1:400,q:.8,a:.2,att:.005,dur:.14});break;
   case 'skidStart':if(spd>2)this._burst({type:'bandpass',f0:(this._skF||900)*1.2,f1:this._skF||900,q:1.2,a:.15+.2*k,att:.01,dur:.22});break;
  }
 },

 // legacy one-shots (same signatures as before)
 thump(k){if(!this.ctx||!this._L||!this.on)return;k=clamp(fin(k,.5),0,1);const t=this.ctx.currentTime+.005;
  this._thud(t,k,110,38,.2);this._burst({type:'lowpass',f0:900,f1:600,q:.7,a:.8*k,att:.003,dur:.22});},
 tone(f,dur,v=.25,type='sine',when=0){if(!this.ctx||!this._L||!this.on)return;const c=this.ctx,t=c.currentTime+Math.max(0,fin(when));
  dur=Math.max(.02,fin(dur,.2));const o=c.createOscillator(),g=c.createGain();o.type=type;o.frequency.value=this._f(f);
  g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(clamp(fin(v,.25),0,1),t+.01);g.gain.exponentialRampToValueAtTime(.001,t+dur);
  o.connect(g);g.connect(this.bus.ui);o.start(t);o.stop(t+dur+.05);o.onended=()=>{try{g.disconnect();}catch(_){}};},
 chime(){this.tone(988,.5,.18);this.tone(1480,.7,.15,'sine',.09);}};

export default SFX;
