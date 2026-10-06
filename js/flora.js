// flora.js — forest, ground cover and rocks for the open mountain.
// API (game.js): floraReady · populateTile(i,j) → Promise<{group,col,lod}> · updateFlora(dt,now,camera,riderPos)
// Tile contents are generated deterministically off the main thread (flora_worker.js, which falls back to running here).
// Nothing is drawn per tile: every visible plant is written each few frames into a handful of global instanced "pools"
// chosen by distance to the camera — full trees near, light trees mid-range, baked impostors to the horizon — so the
// whole forest costs ~35 draw calls whatever direction you ride.
import * as THREE from 'three';
import {mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';
import {clamp,lerp,smooth,rng,noise2,fbm,isMobile,TILE,MOUNTAIN,MOUNTAINS} from './core.js';
import {renderer,scene} from './world.js';
import {genTile,genGround,SETS,PROP_KEYS,GROUND_KEYS,KIND,T_STRIDE,P_STRIDE,G_STRIDE,SUB} from './flora_worker.js';
// ───────────────────────── vegetation, rocks, logs
// Textures are generated offline by tools/flora_tex.py (atlases, see REG below). Trees are built from
// alpha-tested branch / leaf cards around an opaque needle core; distant trees are camera-facing impostors
// baked at load from the same geometry. One shader patch (patch()) adds wind, wrap + translucent foliage
// lighting, mip-aware alpha test (alpha-to-coverage on desktop), distance fade and billboarding.

// ───────────────────────── textures
const T_MOD=performance.now();const TL=new THREE.TextureLoader();
const texP=[];
function tex(url,srgb=true,repeat=false){const t=TL.load(url);t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;t.anisotropy=isMobile?2:4;
 if(repeat)t.wrapS=t.wrapT=THREE.RepeatWrapping;
 texP.push(new Promise(res=>{const done=()=>res();const i=setInterval(()=>{if(t.image&&t.image.complete!==false&&t.image.width){clearInterval(i);done();}},20);setTimeout(()=>{clearInterval(i);done();},12000);}));
 return t;}
const TX={con:tex('tex/flora/conifer.png'),asp:tex('tex/flora/aspen.png'),pla:tex('tex/flora/plants.png'),rock:tex('tex/flora/rock.jpg',true,true),rain:tex('tex/flora/rain.png')};
// atlas regions in pixels [x,y,w,h] of each image (top-left origin)
const REG={
 spruce:['con',0,0,512,512],pine:['con',512,0,512,512],dead:['con',0,512,512,256],core:['con',0,768,512,256],bark:['con',512,512,256,512],wood:['con',768,512,256,512],
 leafGold:['asp',0,0,512,512],aspBark:['asp',512,0,256,512],leafLime:['asp',768,0,256,256],leafBush:['asp',768,256,256,256],
 grass:['pla',0,0,512,512],meadow:['pla',512,0,512,512],fern:['pla',0,512,512,256],fringe:['pla',0,768,512,256],
 cedar:['rain',0,0,512,512],doug:['rain',512,0,512,512],sword:['rain',0,512,512,256],salal:['rain',0,768,512,256],moss:['rain',512,512,128,512],mossBark:['rain',640,512,256,512],rcore:['rain',896,512,128,256],mossWood:['rain',896,768,128,256],
 fl0:['pla',512,512,256,256],fl1:['pla',768,512,256,256],fl2:['pla',512,768,256,256],fl3:['pla',768,768,256,256]};
const ATLAS={con:[1024,1024],asp:[1024,512],pla:[1024,1024],rain:[1024,1024]};
// (u,v) in 0..1 within a region -> atlas uv (v=1 is the top of the region; textures use flipY)
function ruv(name){const [a,x,y,w,h]=REG[name],[W,H]=ATLAS[a];const x0=x+.75,y0=y+.75,w1=w-1.5,h1=h-1.5;
 return (u,v)=>[(x0+u*w1)/W,1-(y0+(1-v)*h1)/H];}

// ───────────────────────── geometry builder
class GB{constructor(){this.p=[];this.n=[];this.t=[];this.c=[];this.w=[];this.i=[];}
 v(p,n,uv,c,w){this.p.push(p[0],p[1],p[2]);const l=Math.hypot(n[0],n[1],n[2])||1;this.n.push(n[0]/l,n[1]/l,n[2]/l);this.t.push(uv[0],uv[1]);this.c.push(c[0],c[1],c[2]);this.w.push(w[0],w[1],w[2]);return this.p.length/3-1;}
 quad(a,b,c,d){this.i.push(a,b,c,a,c,d);}
 get tris(){return this.i.length/3;}
 build(){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(this.p,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(this.n,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(this.t,2));g.setAttribute('color',new THREE.Float32BufferAttribute(this.c,3));g.setAttribute('aWind',new THREE.Float32BufferAttribute(this.w,3));
  g.setIndex(this.i);g.computeBoundingSphere();g.computeBoundingBox();return g;}}
const V={add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],mul:(a,s)=>[a[0]*s,a[1]*s,a[2]*s],
 dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
 norm:a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];},len:a=>Math.hypot(a[0],a[1],a[2])};
const lin=(r,g,b)=>[Math.pow(r,2.2),Math.pow(g,2.2),Math.pow(b,2.2)];
// A ribbon (alpha card) along a polyline. hw[k] = half-width vector. alongV: texture "up" runs along the polyline.
function ribbon(gb,pts,hw,uvf,alongV,colF,nrmF,windF){const m=pts.length-1;let prev=null;
 for(let k=0;k<=m;k++){const t=k/m,a=V.sub(pts[k],hw[k]),b=V.add(pts[k],hw[k]);
  const ua=alongV?uvf(0,t):uvf(t,0),ub=alongV?uvf(1,t):uvf(t,1);
  const ia=gb.v(a,nrmF(a,t),ua,colF(a,t),windF(a,t)),ib=gb.v(b,nrmF(b,t),ub,colF(b,t),windF(b,t));
  if(prev)gb.quad(prev[0],prev[1],ib,ia);prev=[ia,ib];}}
// A tube along a path; v restarts at each texture repeat (the bark textures tile vertically) so atlas UVs never wrap.
function tube(gb,pts,rad,sides,uvf,texLen,colF,windF,uSpan=1){
 const frame=(T)=>{const ref=Math.abs(T[1])<.95?[0,1,0]:[1,0,0];const N=V.norm(V.cross(ref,T)),B=V.cross(T,N);return[N,B];};
 let acc=0;
 for(let k=0;k<pts.length-1;k++){const p0=pts[k],p1=pts[k+1],seg=V.len(V.sub(p1,p0));if(seg<1e-5)continue;const T=V.norm(V.sub(p1,p0));const [N,B]=frame(T);
  let v0=(acc/texLen)%1,v1=v0+seg/texLen;const cuts=[[0,v0,Math.min(v1,1)]];
  if(v1>1){const f=(1-v0)/(v1-v0);cuts[0]=[0,v0,1,f];cuts.push([f,0,v1-1,1]);}else cuts[0].push(1);
  for(const [f0,va,vb,f1] of cuts){const ring=(f,vv)=>{const p=V.add(p0,V.mul(V.sub(p1,p0),f)),r=lerp(rad[k],rad[k+1],f),ids=[];
    for(let j=0;j<=sides;j++){const a=j/sides*Math.PI*2,d=V.add(V.mul(N,Math.cos(a)),V.mul(B,Math.sin(a)));
     ids.push(gb.v(V.add(p,V.mul(d,r)),d,uvf(j/sides*uSpan,vv),colF(p,d),windF(p)));}return ids;};
   const A=ring(f0,va),Bv=ring(f1,vb);for(let j=0;j<sides;j++)gb.quad(A[j],A[j+1],Bv[j+1],Bv[j]);}
  acc+=seg;}}
function rotAbout(v,axis,ang){const c=Math.cos(ang),s=Math.sin(ang),k=axis;const kv=V.cross(k,v),kd=V.dot(k,v);
 return[v[0]*c+kv[0]*s+k[0]*kd*(1-c),v[1]*c+kv[1]*s+k[1]*kd*(1-c),v[2]*c+kv[2]*s+k[2]*kd*(1-c)];}

// ───────────────────────── conifers
// sp: H height, yb crown base, rMax crown radius, prof(t) radius profile, dy whorl spacing, per branches/whorl,
// droop (rad), reg branch texture, tint, dead (lower dead twigs), hwK card half-width / length
function conifer(seed,sp,lite=false){const r=rng(seed),gb=new GB(),H=sp.H,dens=(isMobile?.72:1)*(lite?.62:1);
 const tint=sp.tint,lean=[(r()-.5)*.25,0,(r()-.5)*.25];const tw=sp.twist||0,tph=tw?r()*6.283:0;
 const sway=y=>.18*Math.pow(clamp(y/H,0,1),1.6)*Math.min(H/16,1.6);
 const trunkR=y=>sp.tr*(1-.88*y/H)+sp.tr*(sp.flare??.55)*Math.exp(-y*2.6/(sp.flareH||1));
 const axis=y=>{const q=Math.min(1,Math.max(0,y)/3);return[lean[0]*y/H+tw*Math.sin(y*.5+tph)*q,y,lean[2]*y/H+tw*Math.cos(y*.43+tph)*q];};
 const RW=ruv(sp.woodR||'wood'),RD=sp.deadR===null?null:ruv('dead'),sides=sp.big?(lite?6:isMobile?8:10):lite?5:isMobile?6:7;
 // trunk
 {const pts=[],rad=[];const top=sp.snag?H:sp.reg==='pine'?H*.97:H*(sp.trunkTop||.8);for(let y=-.6;y<=top+1e-3;y+=Math.min(lite?4:2.6,top/(lite?3:6))){pts.push(axis(y));rad.push(Math.max(.02,trunkR(Math.max(0,y))));}
  const bark=sp.snag?(sp.barkR?ruv(sp.barkR):RW):ruv(sp.barkR||'bark');const tl=Math.max(2,sp.tr*2*Math.PI*(sp.big?1.2:2.4));const bc=sp.barkCol||(sp.snag?[.78,.76,.74]:[.66,.64,.64]);
  tube(gb,pts,rad,sides,bark,tl,(p)=>{const g=.55+.45*smooth(-.3,2.2,p[1]);return V.mul(bc,g);},p=>[sway(p[1]),0,0]);}
 if(sp.snag){// broken limbs and a few dead twig cards
  for(let k=0;k<11;k++){const y=H*(.25+r()*.68),a=r()*6.283,L=(.4+r()*1.3)*(1-y/H*.6),dr=-.15-r()*.5;const d=[Math.cos(a)*Math.cos(dr),Math.sin(dr),Math.sin(a)*Math.cos(dr)];
   const p0=axis(y);tube(gb,[p0,V.add(p0,V.mul(d,L*(sp.big?1.8:1)))],[(.05+.04*(1-y/H))*(sp.big?2.5:1),.012],3,RW,2,()=>[.7,.68,.66],p=>[sway(p[1]),0,0]);}
  if(RD)for(let k=0;k<7;k++){const y=H*(.3+r()*.6),a=r()*6.283,L=1+r()*1.2,dr=.2+r()*.3;const d=[Math.cos(a)*Math.cos(dr),-Math.sin(dr),Math.sin(a)*Math.cos(dr)];
   const p0=axis(y),side=V.norm(V.cross(d,[0,1,0]));ribbon(gb,[p0,V.add(p0,V.mul(d,L))],[V.mul(side,L*.25),V.mul(side,L*.25)],RD,false,()=>[.8,.78,.76],()=>[d[0],.6,d[2]],p=>[sway(p[1]),r(),.02]);}
  return gb.build();}
 const yb=sp.yb,Rc=t=>sp.rMax*sp.prof(clamp(t,0,1));
 // opaque needle core
 {const cu=ruv(sp.coreR||'core'),ns=lite?5:isMobile?6:7,rings=lite?3:5,ids=[];
  for(let i=0;i<=rings;i++){const t=i/rings,y=lerp(yb+.3,H*.93,t),rr=Rc((y-yb)/(H-yb))*.22+.05,row=[];
   for(let j=0;j<=ns;j++){const a=j/ns*6.283,d=[Math.cos(a),0,Math.sin(a)];const p=V.add(axis(y),V.mul(d,rr));
    row.push(gb.v(p,[d[0],.55,d[2]],cu(j/ns,t),V.mul(tint,1.05+.25*t),[sway(y),0,0]));}ids.push(row);}
  for(let i=0;i<rings;i++)for(let j=0;j<ns;j++)gb.quad(ids[i][j],ids[i][j+1],ids[i+1][j+1],ids[i+1][j]);
  // closed tip
 }
 // branch cards in whorls
 const bu=ruv(sp.reg),RM=sp.moss?ruv('moss'):null;let y=yb;
 while(y<H-.35){const t=(y-yb)/(H-yb),R=Rc(t);let per=Math.round(sp.per*(.8+r()*.5)*dens);if(R<.7)per=Math.min(per,3);const a0=r()*6.283;
  for(let j=0;j<per;j++){if(r()<sp.gap)continue;const a=a0+j*6.283/per+(r()-.5)*.9;const L=Math.max(.4,R*(.9+r()*.38));
   const d1=sp.droop*(1-.5*t)+(r()-.5)*.3,d2=d1-sp.upturn;const yy=y+(r()-.5)*sp.dy*.5;
   const dir1=[Math.cos(a)*Math.cos(d1),-Math.sin(d1),Math.sin(a)*Math.cos(d1)],dir2=[Math.cos(a)*Math.cos(d2),-Math.sin(d2),Math.sin(a)*Math.cos(d2)];
   const p0=V.add(axis(yy),V.mul([Math.cos(a),0,Math.sin(a)],trunkR(yy)*.6)),p1=V.add(p0,V.mul(dir1,L*.5)),p2=V.add(p1,V.mul(dir2,L*.5));
   const sd0=[-Math.sin(a),0,Math.cos(a)];const two=!lite&&t<.55;const base=(r()-.5)*.5;
   for(const sgn of[-1,1]){const roll=base+sgn*(.5+r()*.3);const hwv=V.mul(rotAbout(sd0,dir1,roll),L*sp.hwK*(lite?1.15:1));
    const flip=r()<.5;const uvf=flip?(u,v)=>bu(u,1-v):bu;const br=.88+r()*.24;
    ribbon(gb,two?[p0,p1,p2]:[p0,V.add(p0,V.mul(V.norm(V.add(dir1,dir2)),L))],two?[V.mul(hwv,.55),hwv,V.mul(hwv,.8)]:[V.mul(hwv,.6),V.mul(hwv,.9)],uvf,false,
     (p,tt)=>{const q=V.sub(p,axis(p[1])),rd=Math.hypot(q[0],q[2])/Math.max(R,.3);const ao=(.5+.5*clamp(rd,0,1))*(.8+.28*clamp((p[1]-yb)/(H-yb),0,1))*br;return V.mul(tint,ao);},
     (p)=>{const q=V.sub(p,axis(p[1]));return[q[0],.5*Math.max(R,.6)+.3,q[2]];},
     (p,tt)=>[sway(p[1]),r(),.03*tt*tt*Math.min(1,L/2)]);}
   // hanging moss draped from the branch
   if(sp.moss&&r()<sp.moss*(lite?.6:1)){const Lm=(1+r()*2.2)*(sp.big?1.3:1),wm=.3+r()*.35,q=V.add(p0,V.mul(V.sub(p2,p0),.35+r()*.4));const sdm=V.mul(V.norm([sd0[0]+(r()-.5),0,sd0[2]+(r()-.5)]),wm);const ph2=r();
    ribbon(gb,[V.add(q,[0,-Lm,0]),V.add(q,[0,-Lm*.45,0]),q],[sdm,V.mul(sdm,.9),V.mul(sdm,.7)],RM,true,(p,tt)=>[.75+.25*tt,.8+.2*tt,.7+.2*tt],(p)=>{const qq=V.sub(p,axis(p[1]));return[qq[0],.4,qq[2]];},(p,tt)=>[sway(p[1]),ph2,.07*(1-tt)]);}}
  y+=sp.dy*(lite?1.3:1)*(.8+r()*.4);}
 // leader at the apex
 for(let k=0;k<2;k++){const a=k*1.571+r(),sd=[Math.cos(a),0,Math.sin(a)];const p0=axis(H-1.5),p1=axis(H-.6),p2=V.add(axis(H+.25),[(r()-.5)*.1,0,0]);
  ribbon(gb,[p0,p1,p2],[V.mul(sd,.42),V.mul(sd,.3),V.mul(sd,.12)],(u,v)=>bu(v,u),true,()=>V.mul(tint,1.05),()=>[0,1,0],p=>[sway(p[1]),r(),.02]);}
 // broken-off limbs on the long clear trunk of the giants
 if(sp.big&&!lite){for(let yy=3;yy<yb-1;yy+=1.4+r()*1.2){const a=r()*6.283,L=.4+r()*1.2,dr=-.1-r()*.4;const d=[Math.cos(a)*Math.cos(dr),Math.sin(dr),Math.sin(a)*Math.cos(dr)];
  const p0=V.add(axis(yy),V.mul([Math.cos(a),0,Math.sin(a)],trunkR(yy)*.85));tube(gb,[p0,V.add(p0,V.mul(d,L))],[.12,.04],3,RW,2,()=>[.7,.66,.6],()=>[0,0,0]);}}
 // dead twigs below the crown
 if(sp.dead&&!lite&&RD){const tw=RD;for(let yy=1.1;yy<yb;yy+=.45){for(let j=0;j<2;j++){if(r()<.35)continue;const a=r()*6.283,L=.7+r()*1.1,dr=.25+r()*.35;
  const d=[Math.cos(a)*Math.cos(dr),-Math.sin(dr),Math.sin(a)*Math.cos(dr)],p0=axis(yy),side=V.norm(V.cross(d,[0,1,0]));
  ribbon(gb,[p0,V.add(p0,V.mul(d,L))],[V.mul(side,L*.25),V.mul(side,L*.25)],tw,false,()=>[.62,.58,.55],()=>[d[0],.5,d[2]],()=>[0,0,0]);}}}
 return gb.build();}

const SPECIES={
 spruceA:{seed:11,H:16,yb:1.2,rMax:3.2,tr:.26,prof:t=>Math.pow(1-t,.9)*(.82+.18*smooth(0,.15,t)),dy:.8,per:5,droop:.5,upturn:.38,reg:'spruce',tint:[.92,1,.94],dead:true,hwK:.42,gap:.06},
 spruceB:{seed:23,H:19,yb:2.2,rMax:3.0,tr:.3,prof:t=>Math.pow(1-t,.95)*(.85+.15*Math.sin(t*19)),dy:.85,per:5,droop:.6,upturn:.42,reg:'spruce',tint:[.85,.95,.9],dead:true,hwK:.42,gap:.16},
 fir:{seed:37,H:14,yb:.6,rMax:2.1,tr:.2,prof:t=>Math.pow(1-t,1.05),dy:.72,per:5,droop:.28,upturn:.3,reg:'spruce',tint:[.8,.96,1.06],dead:false,hwK:.44,gap:.05},
 pine:{seed:51,H:18,yb:9,rMax:2.4,tr:.22,prof:t=>Math.pow(Math.sin(Math.PI*(.15+.85*t)),.55)*(1-.35*t),dy:.85,per:4,droop:.05,upturn:.25,reg:'pine',tint:[1,1,.95],dead:true,hwK:.46,gap:.1},
 snag:{seed:67,H:12,tr:.24,snag:true},
 // Widowmaker: alpine larch (golden), krummholz, stunted subalpine fir, twisted whitebark pine
 larch:{seed:81,H:15,yb:1.6,rMax:2.4,tr:.24,prof:t=>Math.pow(1-t,.8)*(.72+.28*Math.sin(t*13+1)),dy:.9,per:4,droop:.12,upturn:.35,reg:'pine',tint:[1.55,1.1,.42],dead:true,hwK:.4,gap:.3,twist:.22},
 larchB:{seed:85,H:11,yb:1.2,rMax:2.2,tr:.22,prof:t=>Math.pow(1-t,.7)*(.65+.35*Math.sin(t*9+2)),dy:.9,per:4,droop:.05,upturn:.4,reg:'pine',tint:[1.45,1.18,.52],dead:true,hwK:.42,gap:.38,twist:.45},
 krumm:{seed:91,H:3.2,yb:.05,rMax:1.9,tr:.12,prof:t=>Math.pow(1-t,.6)*(t<.35?1:.55),dy:.34,per:6,droop:.15,upturn:.2,reg:'spruce',tint:[.72,.86,.8],dead:false,hwK:.5,gap:.1,twist:.15},
 stuntFir:{seed:97,H:7.5,yb:.3,rMax:1.25,tr:.14,prof:t=>Math.pow(1-t,1.1)*(.7+.3*Math.sin(t*11)),dy:.5,per:4,droop:.25,upturn:.3,reg:'spruce',tint:[.76,.92,1.04],dead:false,hwK:.46,gap:.28,twist:.2},
 whitebark:{seed:103,H:10,yb:3,rMax:2.6,tr:.26,prof:t=>Math.pow(Math.sin(Math.PI*(.2+.8*t)),.5)*(1-.2*t),dy:.8,per:4,droop:-.1,upturn:.3,reg:'pine',tint:[.85,.95,.85],dead:true,hwK:.48,gap:.2,twist:.6,trunkTop:.9},
 snagAlp:{seed:109,H:9,tr:.22,snag:true,twist:.4},
 // Shoreline: old-growth western redcedar, Douglas fir and hemlock, mossy and enormous
 cedar:{seed:131,H:42,yb:7,rMax:6,tr:1.0,flare:1.1,flareH:2.5,prof:t=>Math.pow(1-t,.8)*(.75+.25*smooth(0,.2,t)),dy:1.25,per:5,droop:.75,upturn:.7,reg:'cedar',tint:[.82,.95,.82],barkR:'mossBark',coreR:'rcore',woodR:'mossWood',deadR:null,barkCol:[.85,.8,.78],hwK:.5,gap:.08,moss:.22,big:true},
 doug:{seed:137,H:48,yb:20,rMax:5,tr:.95,flare:.75,flareH:2.5,prof:t=>Math.pow(1-t,.85)*(.8+.2*Math.sin(t*9)),dy:1.3,per:5,droop:.35,upturn:.35,reg:'doug',tint:[.78,.92,.82],barkR:'mossBark',coreR:'rcore',woodR:'mossWood',deadR:null,barkCol:[.78,.72,.7],hwK:.45,gap:.15,moss:.3,big:true,trunkTop:.85},
 hemlock:{seed:139,H:34,yb:5,rMax:4.2,tr:.6,flare:.7,flareH:2,prof:t=>Math.pow(1-t,.9),dy:1.05,per:5,droop:.6,upturn:.3,reg:'doug',tint:[.92,1.04,.84],barkR:'mossBark',coreR:'rcore',woodR:'mossWood',deadR:null,barkCol:[.8,.76,.74],hwK:.46,gap:.08,moss:.2,big:true},
 // Desert (Rampage): Utah juniper (multi-stem, shaggy, blue-grey), pinyon pine (rounded), dead silver juniper
 juniper:{seed:161,H:5.5,yb:.35,rMax:2.1,tr:.2,flare:.9,prof:t=>Math.pow(1-t,.55)*(.6+.4*Math.sin(t*7+1.3)),dy:.42,per:5,droop:-.15,upturn:.3,reg:'spruce',tint:[.7,.86,.8],dead:false,hwK:.5,gap:.38,twist:.7,trunkTop:.7,barkCol:[.75,.68,.62]},
 pinyon:{seed:167,H:7.5,yb:1.2,rMax:2.4,tr:.22,prof:t=>Math.pow(Math.sin(Math.PI*(.12+.88*t)),.6)*(1-.3*t),dy:.55,per:5,droop:0,upturn:.3,reg:'pine',tint:[.88,.95,.78],dead:true,hwK:.48,gap:.25,twist:.35},
 juniperDead:{seed:173,H:4.5,tr:.2,snag:true,twist:.9,barkCol:[.92,.9,.86]},
 snagRain:{seed:149,H:28,tr:.75,snag:true,barkR:'mossBark',woodR:'mossWood',deadR:null,big:true,barkCol:[.72,.7,.66],flare:.6,flareH:2}};
const TREE_MAT_OF=k=>k.startsWith('aspen')?'asp':SPECIES[k]&&SPECIES[k].barkR?'rain':'con';

// ───────────────────────── aspens & bushes
function crownCards(gb,r,n,c,rad,size,regs,tint,swayF,flut){
 for(let k=0;k<n;k++){const u=Math.pow(r(),.35),th=r()*6.283,ph=Math.acos(2*r()-1);const dir=[Math.sin(ph)*Math.cos(th),Math.cos(ph)*.9+.1,Math.sin(ph)*Math.sin(th)];
  const pc=[c[0]+dir[0]*rad[0]*u,c[1]+dir[1]*rad[1]*u,c[2]+dir[2]*rad[2]*u];const s=size*(.8+r()*.45);
  const nrm=V.norm(V.add(dir,[(r()-.5)*1.4,(r()-.5)*1.2,(r()-.5)*1.4]));const ref=Math.abs(nrm[1])<.9?[0,1,0]:[1,0,0];
  let ax=V.norm(V.cross(ref,nrm)),ay=V.cross(nrm,ax);const rot=r()*6.283;const ax2=V.add(V.mul(ax,Math.cos(rot)),V.mul(ay,Math.sin(rot)));ay=V.cross(nrm,ax2);ax=ax2;
  const reg=ruv(regs[Math.floor(r()*regs.length)]);const phase=r();const br=.85+r()*.3;
  const corner=(sx,sy)=>V.add(pc,V.add(V.mul(ax,sx*s*.5),V.mul(ay,sy*s*.5)));
  const ids=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy])=>{const p=corner(sx,sy);const q=[(p[0]-c[0])/rad[0],(p[1]-c[1])/rad[1],(p[2]-c[2])/rad[2]];const dd=clamp(V.len(q),0,1.2);
   return gb.v(p,[q[0],q[1]+.25,q[2]],reg((sx+1)/2,(sy+1)/2),V.mul(tint,(.45+.55*dd)*br*(.85+.15*clamp(q[1],0,1))),[swayF(p[1]),phase,flut]);});
  gb.quad(ids[0],ids[1],ids[2],ids[3]);}}
function aspenGeo(seed,lime,lite=false){const r=rng(seed),gb=new GB(),H=11.5+r()*2;const lean=[(r()-.5)*.5,0,(r()-.5)*.5];
 const axis=y=>{const q=Math.pow(Math.max(0,y)/H,1.5);return[lean[0]*q+Math.sin(y*.4)*.08,y,lean[2]*q];};const sway=y=>.25*Math.pow(clamp(y/H,0,1),1.8);
 const pts=[],rad=[];for(let y=-.5;y<=H*.92;y+=H/10){pts.push(axis(y));rad.push(Math.max(.025,.17*(1-.85*Math.max(0,y)/H)+.06*Math.exp(-Math.max(0,y)*2)));}
 tube(gb,pts,rad,lite?5:isMobile?6:7,ruv('aspBark'),2.4,p=>{const k=smooth(.2,2.4,p[1]);return[lerp(.3,1,k),lerp(.29,1,k),lerp(.26,.97,k)];},p=>[sway(p[1]),0,0]);
 const c=[lean[0]*.7,H*.7,lean[2]*.7],rd=[2.2+r()*.5,3.1+r()*.5,2.2+r()*.5];
 for(let k=0;k<(lite?4:9);k++){const y=H*(.42+r()*.42),a=r()*6.283,el=.6+r()*.5,L=1.3+r()*1.5;const d=[Math.cos(a)*Math.cos(el),Math.sin(el),Math.sin(a)*Math.cos(el)];
  const p0=axis(y);tube(gb,[p0,V.add(p0,V.mul(d,L*.5)),V.add(p0,V.add(V.mul(d,L),[0,.3,0]))],[.05,.03,.012],3,ruv('aspBark'),2,()=>[.75,.75,.72],p=>[sway(p[1]),0,0]);}
 const regs=lime?['leafLime','leafGold','leafLime']:['leafGold','leafGold','leafGold','leafLime'];
 crownCards(gb,r,lite?(isMobile?20:26):isMobile?36:52,c,rd,lite?1.85:1.45,regs,[1,1,1],sway,.045);
 return gb.build();}
function heatherGeo(seed){const r=rng(seed),gb=new GB();crownCards(gb,r,isMobile?9:12,[0,.16,0],[.5,.2,.5],.38,['leafBush','leafLime','leafBush'],[1,1,1],y=>.03*y,.012);return gb.build();}
function salalGeo(seed){const r=rng(seed),gb=new GB();const sway=y=>.05*y;
 for(let k=0;k<3;k++){const a=r()*6.283;const d=[Math.cos(a)*.6,1,Math.sin(a)*.6];tube(gb,[[0,-.1,0],V.mul(d,.8)],[.03,.01],3,ruv('mossWood'),2,()=>[.5,.4,.32],()=>[0,0,0]);}
 crownCards(gb,r,isMobile?11:15,[0,.55,0],[.95,.5,.95],.8,['salal'],[1,1,1],sway,.02);return gb.build();}
function yuccaGeo(seed){const r=rng(seed),gb=new GB(),uv=ruv('core');const n=isMobile?16:22;
 for(let k=0;k<n;k++){const a=r()*6.283,el=.35+r()*1.05,L=.45+r()*.35;const d=[Math.cos(a)*Math.cos(el),Math.sin(el),Math.sin(a)*Math.cos(el)],sd=[-Math.sin(a),0,Math.cos(a)];
  const pts=[[0,.05,0],V.add([0,.05,0],V.mul(d,L*.5)),V.add([0,.05,0],V.add(V.mul(d,L),[0,-.04*(1-el),0]))];const g=.7+r()*.3;
  ribbon(gb,pts,[V.mul(sd,.022),V.mul(sd,.018),V.mul(sd,.002)],(u,v)=>uv(u*.2,v*.2),false,(p,t)=>[g*(.95+.35*t),g*(1.15+.2*t),g*(.85+.2*t)],()=>[d[0],.7,d[2]],(p,t)=>[0,0,0]);}
 // flower stalk on some
 const h=1.1+r()*.6;tube(gb,[[0,.1,0],[0,h,0]],[.018,.01],4,uv,9,()=>[.85,.75,.45],()=>[0,0,0]);
 for(let k=0;k<10;k++){const y=h*(.65+.35*k/10),a=r()*6.283;const p0=[Math.cos(a)*.05,y,Math.sin(a)*.05];
  ribbon(gb,[p0,V.add(p0,[Math.cos(a)*.07,-.04,Math.sin(a)*.07])],[[0,.03,0],[0,.03,0]],(u,v)=>uv(u*.1,v*.1),false,()=>[3,2.9,2.4],()=>[Math.cos(a),.3,Math.sin(a)],()=>[0,0,0]);}
 return gb.build();}
function pearGeo(seed){const r=rng(seed),gb=new GB(),uv=ruv('core');
 const pad=(c,nrm,up,sz,g)=>{const rt=V.norm(V.cross(up,nrm)),ns=8,ids=[gb.v(c,nrm,uv(.5,.5),[g*.9,g*1.15,g*.75],[0,0,0])];
  for(let j=0;j<=ns;j++){const a=j/ns*6.283;const p=V.add(c,V.add(V.mul(rt,Math.cos(a)*sz*.38),V.mul(up,Math.sin(a)*sz*.5)));ids.push(gb.v(p,nrm,uv(.5+.1*Math.cos(a),.5+.1*Math.sin(a)),[g*.85,g*1.1,g*.7],[0,0,0]));}
  for(let j=1;j<=ns;j++)gb.i.push(ids[0],ids[j],ids[j+1]);
  if(r()<.4){const tp=V.add(c,V.mul(up,sz*.5));for(let q=0;q<2;q++)ribbon(gb,[tp,V.add(tp,[0,.05,0])],[V.mul(rt,.03),V.mul(rt,.03)],(u,v)=>uv(u*.1,v*.1),false,()=>[2.4,1.4,1.2],()=>nrm,()=>[0,0,0]);}};
 const grow=(c,up,sz,depth)=>{const a=r()*6.283;const nrm=V.norm([Math.cos(a),(r()-.5)*.3,Math.sin(a)]);const u=V.norm(V.sub(up,V.mul(nrm,V.dot(up,nrm))));const g=.75+r()*.3;
  const ctr=V.add(c,V.mul(u,sz*.45));pad(ctr,nrm,u,sz,g);
  if(depth>0)for(let k=0;k<1+Math.floor(r()*2);k++){const tilt=V.norm(V.add(u,[(r()-.5)*1.2,0,(r()-.5)*1.2]));grow(V.add(ctr,V.mul(u,sz*.4)),tilt,sz*(.75+r()*.15),depth-1);}};
 for(let k=0;k<3;k++){const a=r()*6.283;grow([Math.cos(a)*.15,0,Math.sin(a)*.15],V.norm([Math.cos(a)*.6,1,Math.sin(a)*.6]),.3+r()*.08,2);}
 return gb.build();}
function bushGeo(seed){const r=rng(seed),gb=new GB();const sway=y=>.05*y;
 for(let k=0;k<4;k++){const a=r()*6.283;const d=[Math.cos(a)*.5,1,Math.sin(a)*.5];tube(gb,[[0,-.1,0],V.mul(d,.7)],[.03,.01],3,ruv('wood'),2,()=>[.4,.3,.25],()=>[0,0,0]);}
 crownCards(gb,r,isMobile?12:16,[0,.5,0],[.85,.55,.85],.7,['leafBush','leafBush','leafLime'],[1,1,1],sway,.02);return gb.build();}

// ───────────────────────── ground plants
// A grass patch: n alpha cards scattered over a ~1.3 m disc, mixing lush and seed-head textures.
function grassGeo(seed,n,dryFrac){const r=rng(seed),gb=new GB();
 for(let k=0;k<n;k++){const reg=r()<dryFrac?'meadow':'grass',uvf=ruv(reg);const rr=Math.sqrt(r())*.65,th=r()*6.283,off=[Math.cos(th)*rr,0,Math.sin(th)*rr];
  const h=(reg==='meadow'?.6:.48)*(.65+r()*.6)*(1-.3*rr),w=h*(.85+r()*.4),a=r()*Math.PI,sd=[Math.cos(a),0,Math.sin(a)],fw=[-Math.sin(a),0,Math.cos(a)];
  const lean=(r()-.5)*.3;const pts=[off,V.add(off,[fw[0]*lean*h,h,fw[2]*lean*h])];const ph=r();
  ribbon(gb,pts,[V.mul(sd,w*.5),V.mul(sd,w*.56)],uvf,true,(p,t)=>{const g=.42+.58*t;return[g,g,g];},()=>[fw[0]*.2,1,fw[2]*.2],(p,t)=>[.16*h*t,ph,.03*h*t]);}
 return gb.build();}
function fernGeo(seed,reg='fern',n=isMobile?6:8,L0=.65,Lr=.4,rise0=.55){const r=rng(seed),gb=new GB(),uvf=ruv(reg);
 for(let k=0;k<n;k++){const a=k/n*6.283+(r()-.5)*.5,L=L0+r()*Lr,rise=rise0+r()*.35;const d=[Math.cos(a),0,Math.sin(a)],sd=[-Math.sin(a),0,Math.cos(a)];
  const pts=[0,.25,.5,.75,1].map(t=>[d[0]*L*t,.05+Math.sin(Math.PI*t*.85)*rise*L*.6-t*t*.15,d[2]*L*t]);const hw=pts.map((p,i)=>{const tilt=rotAbout(sd,d,(r()-.5)*.6);return V.mul(tilt,.24*L*(1-.3*i/4));});
  const ph=r();ribbon(gb,pts,hw,uvf,false,(p,t)=>{const g=.55+.45*t;return[g,g,g];},()=>[d[0]*.3,1,d[2]*.3],(p,t)=>[.04*t,ph,.03*t]);}
 return gb.build();}
function flowerGeo(seed,cells){const r=rng(seed),gb=new GB();
 for(let k=0;k<6;k++){const cell=cells[Math.floor(r()*cells.length)],uvf=ruv(cell);const a=r()*Math.PI,s=.38+r()*.25,off=[(r()-.5)*.9,0,(r()-.5)*.9];
  for(let q=0;q<2;q++){const aa=a+q*1.571,sd=[Math.cos(aa),0,Math.sin(aa)];const pts=[0,1].map(t=>V.add(off,[0,t*s,0]));const ph=r();
   ribbon(gb,pts,[V.mul(sd,s*.5),V.mul(sd,s*.5)],uvf,true,(p,t)=>{const g=.6+.4*t;return[g,g,g];},()=>[0,1,0],(p,t)=>[.06*t*t,ph,.015*t]);}}
 return gb.build();}

// ───────────────────────── rocks, logs, stumps, stakes
function rockGeo(seed,detail,cuts){const r=rng(seed);let g=new THREE.IcosahedronGeometry(1,detail);g.deleteAttribute('normal');g.deleteAttribute('uv');g=mergeVertices(g);
 const P=g.attributes.position;const planes=[];for(let k=0;k<cuts;k++){const n=V.norm([r()-.5,(r()-.3)*1.2,r()-.5]);planes.push([n,.62+r()*.25]);}
 const cols=new Float32Array(P.count*3),sx=1.05+r()*.35,sy=.62+r()*.25,sz=.85+r()*.25;
 for(let i=0;i<P.count;i++){let v=[P.getX(i),P.getY(i),P.getZ(i)];const k=1+.18*noise2(v[0]*1.8+seed,v[2]*1.8+v[1]*1.3)+.07*noise2(v[0]*5+v[1]*3,v[2]*5+seed);v=V.mul(v,k);
  for(const [n,o] of planes){const d=V.dot(v,n);if(d>o)v=V.sub(v,V.mul(n,d-o));}
  if(v[1]<-.45)v[1]=-.45+(v[1]+.45)*.3;
  P.setXYZ(i,v[0]*sx,v[1]*sy,v[2]*sz);const ao=.55+.45*smooth(-.45,.3,v[1]);const cv=ao*(.92+.16*noise2(v[0]*3+7,v[2]*3));cols[i*3]=cv;cols[i*3+1]=cv;cols[i*3+2]=cv;}
 g.setAttribute('color',new THREE.BufferAttribute(cols,3));g.computeVertexNormals();g.computeBoundingSphere();return g;}
function logGeo(seed,weathered,mossy=false){const r=rng(seed),gb=new GB(),L=7,rad=.3;const uvf=mossy?ruv('mossWood'):weathered?ruv('wood'):ruv('bark');
 const pts=[];const rr=[];for(let k=0;k<=6;k++){const t=k/6;pts.push([(t-.5)*L,Math.sin(t*3)*.05,(Math.sin(t*2.5+seed)*.12)]);rr.push(rad*(1.12-.3*t));}
 const col=mossy?[.9,.92,.85]:weathered?[.8,.78,.75]:[.7,.64,.6];tube(gb,pts,rr,isMobile?7:9,uvf,mossy?1.2:2.2,(p,d)=>{const ao=.55+.45*smooth(-.25,.25,d[1]);return V.mul(col,ao);},()=>[0,0,0]);
 // end caps (pale cut wood)
 const cu=ruv(mossy?'mossWood':'wood');for(const [k,s] of [[0,-1],[6,1]]){const c=pts[k],ns=8,ids=[gb.v(c,[s,0,0],cu(.5,.5),[1.1,.95,.8],[0,0,0])];
  for(let j=0;j<=ns;j++){const a=j/ns*6.283;ids.push(gb.v([c[0],c[1]+Math.cos(a)*rr[k],c[2]+Math.sin(a)*rr[k]],[s,0,0],cu(.5+.4*Math.cos(a),.5+.2*Math.sin(a)),[.9,.78,.62],[0,0,0]));}
  for(let j=1;j<=ns;j++)gb.i.push(ids[0],ids[j],ids[j+1]);}
 // broken branch stubs
 for(let k=0;k<5;k++){const x=(r()-.5)*L*.8,a=r()*6.283;const p0=[x,Math.cos(a)*rad*.8,Math.sin(a)*rad*.8];const d=V.norm([(r()-.5)*.6,Math.cos(a),Math.sin(a)]);
  tube(gb,[p0,V.add(p0,V.mul(d,.3+r()*.5))],[.06,.02],4,uvf,2,()=>col,()=>[0,0,0]);}
 return gb.build();}
function stumpGeo(seed,mossy=false){const r=rng(seed),gb=new GB();const h=mossy?1.1:.75;const pts=[[0,-.3,0],[0,0,0],[0,.25,0],[0,h,0]],rr=mossy?[.6,.5,.38,.33]:[.48,.44,.34,.31];
 tube(gb,pts,rr,isMobile?7:9,ruv(mossy?'mossWood':'bark'),mossy?1.2:2.2,(p)=>{const ao=.5+.5*smooth(-.3,.4,p[1]);return[.75*ao,.68*ao,.62*ao];},()=>[0,0,0]);
 const cu=ruv(mossy?'mossWood':'wood'),ns=9;const ids=[gb.v([0,h+.02,0],[0,1,0],cu(.5,.5),[1.05,.9,.72],[0,0,0])];
 for(let j=0;j<=ns;j++){const a=j/ns*6.283,jag=(j%2)*.06*r();ids.push(gb.v([Math.cos(a)*.31,h-jag,Math.sin(a)*.31],[0,1,0],cu(.5+.4*Math.cos(a),.5+.2*Math.sin(a)),[.85,.72,.56],[0,0,0]));}
 for(let j=1;j<=ns;j++)gb.i.push(ids[0],ids[j+1],ids[j]);
 return gb.build();}
// ───────────────────────── materials
const U={uTime:{value:0},uRider:{value:new THREE.Vector3(0,-1e4,0)}};
const A2C=!isMobile;   // alpha-to-coverage needs the MSAA scene target (desktop path in world.js)
function patch(sh){const u=this.userData.u||{};sh.uniforms.uTime=U.uTime;Object.assign(sh.uniforms,u);
 sh.vertexShader=sh.vertexShader.replace('#include <common>',`#include <common>
uniform float uTime;varying float vPhase;
#ifdef WIND
attribute vec3 aWind;
#endif
#ifdef DISTFADE
uniform vec2 uFade;
#endif
#ifdef RIDER
uniform vec3 uRider;
#endif
#ifdef BILLBOARD
uniform vec4 uCells[8];attribute float aCell;
#endif
#ifdef ROCK
varying vec3 vWP;varying vec3 vWN;varying float vBase;varying float vScale;
#endif`).replace('#include <begin_vertex>',`#include <begin_vertex>
vPhase=0.;
#ifdef USE_INSTANCING
 vec3 ip=instanceMatrix[3].xyz;
#else
 vec3 ip=vec3(0.);
#endif
#ifdef DISTFADE
 {vec3 wo=(modelMatrix*vec4(ip,1.)).xyz;float f=1.-smoothstep(uFade.x,uFade.y,distance(wo,cameraPosition));transformed*=f;}
#endif
#ifdef WIND
 {float ph=dot(ip.xz,vec2(.071,.053));float gust=.6+.4*sin(uTime*.31+ip.x*.004+ip.z*.006);
  float sw=(sin(uTime*1.05+ph)+.4*sin(uTime*2.27+ph*1.7))*gust;transformed.x+=sw*aWind.x;transformed.z+=sw*aWind.x*.55;
  float fl=sin(uTime*5.3+aWind.y*6.2832+ph*2.)*gust;transformed+=(normal*.6+vec3(0.,.5,0.))*fl*aWind.z;vPhase=aWind.y;}
#endif
#if defined(RIDER)&&defined(USE_INSTANCING)
 {vec3 wo=(modelMatrix*vec4(ip,1.)).xyz;vec2 dv=wo.xz-uRider.xz;float dl=length(dv);float pu=(1.-smoothstep(.35,1.7,dl))*step(abs(wo.y-uRider.y),2.5);
  if(pu>0.){mat3 im=mat3(instanceMatrix);vec3 wv=vec3(dv/max(dl,1e-3),0.)*pu*.55*max(transformed.y,0.)*1.6;wv=vec3(wv.x,-pu*.25*max(transformed.y,0.),wv.y);transformed+=transpose(im)*wv/max(dot(im[0],im[0]),1e-4);}}
#endif
#ifdef ROCK
 {vec4 w4=vec4(transformed,1.);vec3 wn=objectNormal;
  #ifdef USE_INSTANCING
  w4=instanceMatrix*w4;wn=mat3(instanceMatrix)*wn;
  #endif
  w4=modelMatrix*w4;vWP=w4.xyz;vWN=normalize(mat3(modelMatrix)*wn);vBase=(modelMatrix*vec4(ip,1.)).y;
  #ifdef USE_INSTANCING
  vScale=length(instanceMatrix[0].xyz);
  #else
  vScale=1.;
  #endif
  }
#endif`).replace('#include <project_vertex>',`#ifdef BILLBOARD
 vec4 cell=uCells[int(abs(aCell)+.5)];
 vec3 wo=(modelMatrix*vec4(ip,1.)).xyz;float sc=length(instanceMatrix[1].xyz);
 vec3 toC=cameraPosition-wo;toC.y=0.;toC=normalize(toC+vec3(1e-4,0.,0.));vec3 rt=vec3(toC.z,0.,-toC.x);
 vec3 wp=wo+rt*position.x*cell.z*sc+vec3(0.,(position.y*cell.w-.3)*sc,0.);
 vec4 mvPosition=viewMatrix*vec4(wp,1.);gl_Position=projectionMatrix*mvPosition;
 vMapUv=vec2(cell.x+(aCell<0.?1.-uv.x:uv.x)*cell.y,uv.y);
 vNormal=normalize((viewMatrix*vec4(normalize(rt*position.x*1.7+toC*.8+vec3(0.,.25+.35*position.y,0.)),0.)).xyz);
#else
 #include <project_vertex>
#endif`);
 sh.fragmentShader=sh.fragmentShader.replace('#include <common>',`#include <common>
uniform float uTime;varying float vPhase;float gA=1.;
#ifdef FOLIAGE
uniform float uTransl;uniform float uShimmer;
#endif
#ifdef ROCK
uniform sampler2D tRock;uniform float uMoss;varying vec3 vWP;varying vec3 vWN;varying float vBase;varying float vScale;
float rh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float rn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(rh(i),rh(i+vec2(1,0)),f.x),mix(rh(i+vec2(0,1)),rh(i+vec2(1,1)),f.x),f.y);}
#endif`).replace('#include <alphatest_fragment>',`#ifdef USE_ALPHATEST
 #ifdef USE_MAP
 {vec2 tsz=vec2(textureSize(map,0));vec2 dx=dFdx(vMapUv*tsz),dy=dFdy(vMapUv*tsz);float lod=max(0.,.5*log2(max(dot(dx,dx),dot(dy,dy))));diffuseColor.a*=1.+lod*.3;}
 #endif
 #ifdef A2C
 gA=clamp((diffuseColor.a-alphaTest)/max(fwidth(diffuseColor.a),1e-4)+.5,0.,1.);if(gA<.02)discard;
 #else
 if(diffuseColor.a<alphaTest)discard;
 #endif
#endif`).replace('#include <opaque_fragment>',`#include <opaque_fragment>
#ifdef A2C
 gl_FragColor.a=gA;
#endif`);
 if(this.defines.FOLIAGE!==undefined){
  sh.fragmentShader=sh.fragmentShader.replace('#include <normal_fragment_begin>',`float faceDirection=gl_FrontFacing?1.:-1.;vec3 normal=normalize(vNormal);vec3 nonPerturbedNormal=normal;`)
  .replace('#include <color_fragment>',`#include <color_fragment>
#ifdef SHIMMER
 diffuseColor.rgb*=1.+uShimmer*(sin(uTime*7.3+vPhase*41.)*.6+sin(uTime*11.1+vPhase*17.)*.4);
#endif`)
  .replace('#include <lights_physical_pars_fragment>',`#include <lights_physical_pars_fragment>
void RE_Direct_Foliage(const in IncidentLight directLight,const in vec3 geometryPosition,const in vec3 geometryNormal,const in vec3 geometryViewDir,const in vec3 geometryClearcoatNormal,const in PhysicalMaterial material,inout ReflectedLight reflectedLight){
 float nl=dot(geometryNormal,directLight.direction);float wr=saturate((nl+.5)/1.5);
 reflectedLight.directDiffuse+=wr*directLight.color*BRDF_Lambert(material.diffuseColor);
 float back=pow(saturate(dot(-geometryViewDir,directLight.direction)),5.);
 float thin=.3+.7*saturate(.5-nl*.5);
 reflectedLight.directDiffuse+=directLight.color*material.diffuseColor*uTransl*(back*1.6+.1)*thin;}
#undef RE_Direct
#define RE_Direct RE_Direct_Foliage`);}
 if(this.defines.ROCK!==undefined){
  sh.fragmentShader=sh.fragmentShader.replace('#include <map_fragment>',`
 {vec3 bw=pow(abs(vWN),vec3(4.));bw/=bw.x+bw.y+bw.z;vec3 q=vWP*.6;
  vec3 tc=texture2D(tRock,q.zy).rgb*bw.x+texture2D(tRock,q.xz).rgb*bw.y+texture2D(tRock,q.xy).rgb*bw.z;
  diffuseColor.rgb*=tc*1.1;
  float m=smoothstep(.55,.92,vWN.y)*smoothstep(.35,.7,rn(vWP.xz*1.7)*.7+rn(vWP.xz*6.)*.3);
  diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.075,.1,.03)*(.7+.6*rn(vWP.xz*9.)),m*.85*uMoss);
  float g=smoothstep(-.2*vScale,.35*vScale,vWP.y-vBase);diffuseColor.rgb*=.6+.4*g;}`);}
}
function mat(opts){const {map,defines={},u={},side=THREE.DoubleSide,alpha=true,roughness=1,vc=true}=opts;
 const m=new THREE.MeshStandardMaterial({map:map||null,vertexColors:vc,side,roughness,metalness:0,alphaTest:alpha?.5:0});
 m.defines=Object.assign({},defines);if(alpha&&A2C){m.defines.A2C='';m.alphaToCoverage=true;}m.userData.u=u;m.onBeforeCompile=patch;return m;}
const MAT={
 con:mat({map:TX.con,defines:{WIND:'',FOLIAGE:''},u:{uTransl:{value:.3},uShimmer:{value:0}}}),
 asp:mat({map:TX.asp,defines:{WIND:'',FOLIAGE:'',SHIMMER:''},u:{uTransl:{value:.95},uShimmer:{value:.16}}}),
 grass:mat({map:TX.pla,defines:{WIND:'',FOLIAGE:'',DISTFADE:'',RIDER:''},u:{uRider:U.uRider,uTransl:{value:.42},uShimmer:{value:0},uFade:{value:new THREE.Vector2(isMobile?20:26,isMobile?30:40)}}}),
 plants:mat({map:TX.pla,defines:{WIND:'',FOLIAGE:'',DISTFADE:''},u:{uTransl:{value:.7},uShimmer:{value:0},uFade:{value:new THREE.Vector2(isMobile?38:50,isMobile?55:72)}}}),
 rock:mat({defines:{ROCK:''},u:{tRock:{value:TX.rock},uMoss:{value:1}},side:THREE.FrontSide,alpha:false,roughness:.86}),
 rain:mat({map:TX.rain,defines:{WIND:'',FOLIAGE:''},u:{uTransl:{value:.32},uShimmer:{value:0}}}),
 rainPlants:mat({map:TX.rain,defines:{WIND:'',FOLIAGE:'',DISTFADE:''},u:{uTransl:{value:.55},uShimmer:{value:0},uFade:{value:new THREE.Vector2(isMobile?38:50,isMobile?55:72)}}})};

// ───────────────────────── geometry library
const GEO={
 grass:grassGeo(3,isMobile?7:9,.15),meadow:grassGeo(9,isMobile?7:9,.5),
 rockA:rockGeo(3,isMobile?2:3,7),rockB:rockGeo(11,2,9),rockC:rockGeo(29,2,5),pebble:rockGeo(41,1,4),
 rockA_lo:rockGeo(3,0,5),rockB_lo:rockGeo(11,0,6),rockC_lo:rockGeo(29,0,4),
 log:logGeo(1,false),logOld:logGeo(2,true),stump:stumpGeo(4),logMoss:logGeo(5,true,true),stumpMoss:stumpGeo(6,true)};
// everything else is built on first use (per mountain)
const BUILD={aspenA:()=>aspenGeo(71,false),aspenB:()=>aspenGeo(83,true),aspenA_l:()=>aspenGeo(71,false,true),aspenB_l:()=>aspenGeo(83,true,true),
 bush:()=>bushGeo(5),heather:()=>heatherGeo(7),salal:()=>salalGeo(8),fern:()=>fernGeo(13),sword:()=>fernGeo(15,'sword',isMobile?9:12,1.0,.6,.5),
 yucca:()=>yuccaGeo(21),pear:()=>pearGeo(23),sage:()=>heatherGeo(25),rabbit:()=>heatherGeo(27),
 flowersA:()=>flowerGeo(17,['fl0','fl0','fl1','fl3']),flowersB:()=>flowerGeo(19,['fl2','fl2','fl3','fl1'])};
function geo(k){if(GEO[k])return GEO[k];let g;if(BUILD[k])g=BUILD[k]();else{const lite=k.endsWith('_l'),key=lite?k.slice(0,-2):k;g=conifer(SPECIES[key].seed,SPECIES[key],lite);}
 if(g.attributes.position.array.some(Number.isNaN))console.error('flora: NaN geometry',k);return GEO[k]=g;}
const PROP_MAT=k=>k.startsWith('rock')?'rock':k.endsWith('Moss')?'rain':'con';
// per mountain: [geometry, material] for each ground-cover slot
const GROUND_BY={
 ridgeline:{grass:['grass','grass'],meadow:['meadow','grass'],flowersA:['flowersA','plants'],flowersB:['flowersB','plants'],fern:['fern','plants'],bush:['bush','asp'],sapFir:['fir_l','con'],sapSpruce:['spruceA_l','con'],pebble:['pebble','rock']},
 widowmaker:{grass:['grass','grass'],meadow:['meadow','grass'],flowersA:['flowersA','plants'],flowersB:['flowersB','plants'],fern:['heather','asp'],bush:['krumm_l','con'],sapFir:['stuntFir_l','con'],sapSpruce:['larch_l','con'],pebble:['pebble','rock']},
 desert:{grass:['meadow','grass'],meadow:['meadow','grass'],flowersA:['yucca','con'],flowersB:['pear','con'],fern:['sage','asp'],bush:['rabbit','asp'],sapFir:['juniper_l','con'],sapSpruce:['pinyon_l','con'],pebble:['pebble','rock']},
 shoreline:{grass:['grass','grass'],meadow:['meadow','grass'],flowersA:['flowersA','plants'],flowersB:['flowersB','plants'],fern:['sword','rainPlants'],bush:['salal','rain'],sapFir:['hemlock_l','rain'],sapSpruce:['cedar_l','rain'],pebble:['pebble','rock']},
 // Hollowfell: heather (flowersA slot) on the moor, bracken, bilberry, young spruce/fir under the timber
 highland:{grass:['grass','grass'],meadow:['meadow','grass'],flowersA:['heather','asp'],flowersB:['flowersB','plants'],fern:['fern','plants'],bush:['bush','asp'],sapFir:['fir_l','con'],sapSpruce:['spruceA_l','con'],pebble:['pebble','rock']}};

// ───────────────────────── impostors (baked once at load from the real tree geometry)
const CELL=256,IMP_W=CELL*8,IMP_H=CELL*2;
const impRT=new THREE.WebGLRenderTarget(IMP_W,IMP_H,{minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter,generateMipmaps:true,depthBuffer:true});
impRT.texture.colorSpace=THREE.SRGBColorSpace;
const cellsU=[];for(let k=0;k<8;k++)cellsU.push(new THREE.Vector4(0,0,1,1));
// keep the cell aspect 1:2 so texels are square: width is max(w, h/2)
function setCells(keys){keys.forEach((k,i)=>{const bb=geo(k).boundingBox;const w=2*Math.max(-bb.min.x,bb.max.x,-bb.min.z,bb.max.z)*1.04+.3,h=bb.max.y+.3+.3;cellsU[i].set(i/8,1/8,Math.max(w,h*.5),h);});}
function bakeImpostors(keys){try{setCells(keys);
 const sc=new THREE.Scene(),cam=new THREE.OrthographicCamera(-1,1,1,-1,.1,200);
 const prevRT=renderer.getRenderTarget(),prevCol=renderer.getClearColor(new THREE.Color()),prevA=renderer.getClearAlpha(),prevAuto=renderer.autoClear;
 const bm={};for(const a of['con','asp','rain'])bm[a]=new THREE.MeshBasicMaterial({map:TX[a],vertexColors:true,alphaTest:.5,side:THREE.DoubleSide});
 renderer.setRenderTarget(impRT);renderer.autoClear=false;
 renderer.setClearColor(0x000000,0);impRT.scissorTest=false;impRT.viewport.set(0,0,IMP_W,IMP_H);renderer.setRenderTarget(impRT);renderer.clear(true,true,false);
 keys.forEach((k,i)=>{const c=cellsU[i];const m=new THREE.Mesh(geo(k),bm[TREE_MAT_OF(k)]);sc.add(m);
  cam.left=-c.z/2;cam.right=c.z/2;cam.bottom=-.3;cam.top=c.w-.3;cam.position.set(0,0,60);cam.updateProjectionMatrix();
  impRT.viewport.set(i*CELL,0,CELL,IMP_H);impRT.scissor.set(i*CELL,0,CELL,IMP_H);impRT.scissorTest=true;renderer.setRenderTarget(impRT);
  const fill=k.startsWith('aspen')?[.45,.3,.05]:k.startsWith('larch')?[.3,.18,.03]:k==='juniperDead'?[.35,.33,.3]:[.03,.05,.035];renderer.setClearColor(new THREE.Color().setRGB(...fill),0);renderer.clear(true,true,false);
  renderer.render(sc,cam);sc.remove(m);});
 impRT.scissorTest=false;impRT.viewport.set(0,0,IMP_W,IMP_H);
 renderer.setRenderTarget(prevRT);renderer.setClearColor(prevCol,prevA);renderer.autoClear=prevAuto;
 for(const a in bm)bm[a].dispose();}catch(e){console.warn('flora: impostor bake failed',e);}}
const impGeo=(()=>{const g=new THREE.PlaneGeometry(1,1);g.translate(0,.5,0);g.boundingSphere=new THREE.Sphere(new THREE.Vector3(0,.5,0),.75);return g;})();
const impMat=mat({map:impRT.texture,vc:false,defines:{BILLBOARD:'',FOLIAGE:''},u:{uTransl:{value:.4},uShimmer:{value:0},uCells:{value:cellsU}}});
// wait for the atlases (bounded) then bake; top-level await keeps game start until the forest is ready
const T_GEO=performance.now()-T_MOD;let T_BAKE=0,T_SETGEO=0;
const texReady=Promise.all(texP);
export const floraReady=texReady;


// ───────────────────────── tile data (worker)
// Jobs go through our own queue (ground cover first, it is what the rider sees next) with ≤2 in flight per worker,
// so a burst of distant tile requests never delays the grass under the bike.
const workers=[];let wId=0;const wPending=new Map(),qHi=[],qLo=[];
function pump(){for(const w of workers){while(w.busy<2){const j=qHi.shift()||qLo.shift();if(!j)return;w.busy++;j.w=w;wPending.set(j.id,j);w.postMessage(j.msg);}}}
function runLocal(j){setTimeout(()=>{try{j.res(j.local());}catch(e){j.rej(e);}},0);}
try{for(let k=0;k<(isMobile?2:3);k++){const w=new Worker(new URL('./flora_worker.js',import.meta.url),{type:'module'});w.busy=0;
 w.onmessage=e=>{const j=wPending.get(e.data.id);if(!j)return;wPending.delete(e.data.id);w.busy--;e.data.err?j.rej(new Error(e.data.err)):j.res(e.data.res);pump();};
 w.onerror=e=>{e.preventDefault&&e.preventDefault();workers.length=0;for(const [id,j] of wPending){wPending.delete(id);runLocal(j);}for(const j of qHi.splice(0).concat(qLo.splice(0)))runLocal(j);};workers.push(w);}}catch(e){workers.length=0;}
function job(op,i,j){const local=()=>op==='tile'?genTile(i,j):genGround(i,j,isMobile);
 return new Promise((res,rej)=>{const jb={id:++wId,res,rej,local,msg:null};jb.msg={id:jb.id,op,i,j,mobile:isMobile,mtn:MOUNTAIN.id};
  if(!workers.length){runLocal(jb);return;}(op==='ground'?qHi:qLo).push(jb);pump();});}

const tiles=new Map();let dirtyTrees=true,dirtyGround=true,dirtyProps=true,gen=0,mtnId=null,SET=SETS.ridgeline;
const GC_LOAD=isMobile?95:130,GC_FREE=GC_LOAD+90;
// populateTile: deterministic, async (worker). group stays empty: drawing happens in the global pools.
export function populateTile(i,j){if(setId!==MOUNTAIN.id)setMountain(MOUNTAIN.id);const g0=gen;
 return setP.then(()=>job('tile',i,j)).then(d=>{if(g0!==gen)return populateTile(i,j);/* mountain switched while queued: answer for the current one */const T={i,j,cx:(i+.5)*TILE,cz:(j+.5)*TILE,trees:d.trees,props:d.props,ground:null,gBusy:false};tiles.set(i+','+j,T);
  const col=[];for(let k=0;k<d.col.length;k+=4)col.push({x:d.col[k],z:d.col[k+1],r:d.col[k+2],kind:KIND[d.col[k+3]]});
  dirtyTrees=dirtyProps=true;STAT.tiles++;STAT.trees+=d.trees.length/T_STRIDE;STAT.props+=d.props.length/P_STRIDE;STAT.genMs+=d.ms||0;
  const group=new THREE.Group();
  // lod(dist): stream ground cover in/out as the camera approaches/leaves
  const lod=dist=>{if(dist<GC_LOAD&&!T.ground&&!T.gBusy){T.gBusy=true;job('ground',i,j).then(g=>{if(g0!==gen||!g){T.gBusy=false;return;}T.ground=g;STAT.gTiles++;STAT.gGenMs+=g.ms||0;T.gBusy=false;dirtyGround=true;},e=>{T.gBusy=false;console.error(e);});}
   else if(dist>GC_FREE&&T.ground){T.ground=null;dirtyGround=true;}};
  return {group,col,lod};});}

// ───────────────────────── pools
const _sph=new THREE.Sphere();
class Pool{constructor(geo,material,cap,shadow,cell){this.cap=cap;this.n=0;
  const m=this.m=new THREE.InstancedMesh(geo,material,cap);m.count=0;m.visible=false;m.castShadow=shadow;m.receiveShadow=!cell;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);m.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(cap*3),3);m.instanceColor.setUsage(THREE.DynamicDrawUsage);
  if(cell){this.cell=new THREE.InstancedBufferAttribute(new Float32Array(cap),1);this.cell.setUsage(THREE.DynamicDrawUsage);geo.setAttribute('aCell',this.cell);}
  m.boundingSphere=new THREE.Sphere(new THREE.Vector3(),1);m.frustumCulled=true;scene.add(m);this.A=m.instanceMatrix.array;this.C=m.instanceColor.array;}
 begin(){this.n=0;}
 // y-rotation + scale (s horizontal, sy vertical)
 y(x,y,z,ry,s,sy,r,g,b,cell){if(this.n>=this.cap)return;const A=this.A,o=this.n*16,c=Math.cos(ry),sn=Math.sin(ry);
  A[o]=c*s;A[o+1]=0;A[o+2]=-sn*s;A[o+3]=0;A[o+4]=0;A[o+5]=sy;A[o+6]=0;A[o+7]=0;A[o+8]=sn*s;A[o+9]=0;A[o+10]=c*s;A[o+11]=0;A[o+12]=x;A[o+13]=y;A[o+14]=z;A[o+15]=1;
  const k=this.n*3;this.C[k]=r;this.C[k+1]=g;this.C[k+2]=b;if(this.cell)this.cell.array[this.n]=cell;this.n++;}
 mat(m4,r,g,b){if(this.n>=this.cap)return;m4.toArray(this.A,this.n*16);const k=this.n*3;this.C[k]=r;this.C[k+1]=g;this.C[k+2]=b;this.n++;}
 end(cx,cy,cz,rad){const m=this.m;m.count=this.n;m.visible=this.n>0;if(!this.n)return;m.boundingSphere.center.set(cx,cy,cz);m.boundingSphere.radius=rad;
  m.instanceMatrix.clearUpdateRanges();m.instanceMatrix.addUpdateRange(0,this.n*16);m.instanceMatrix.needsUpdate=true;
  m.instanceColor.clearUpdateRanges();m.instanceColor.addUpdateRange(0,this.n*3);m.instanceColor.needsUpdate=true;
  if(this.cell){this.cell.clearUpdateRanges();this.cell.addUpdateRange(0,this.n);this.cell.needsUpdate=true;}}}
// distances (m): full trees, light trees (and how far those cast shadows), impostors to the loaded horizon
const R={full:isMobile?24:40,lite:isMobile?80:125,liteSh:isMobile?50:75,always:isMobile?30:45,grass:isMobile?30:40,plants:isMobile?55:72,props:isMobile?120:170,boulders:isMobile?420:560,rockHi:isMobile?60:90};
const P={full:[],lite:[],liteS:[],imp:null,ground:[],props:[],propsLo:[]};
const GROUND_R=GROUND_KEYS.map(k=>k==='grass'||k==='meadow'?R.grass:k==='pebble'?R.grass+10:R.plants);
const GROUND_CAP={grass:isMobile?3500:7000,meadow:isMobile?2500:5000,flowersA:600,flowersB:600,fern:isMobile?1800:2600,bush:1000,sapFir:300,sapSpruce:300,pebble:isMobile?2000:3000};
P.imp=new Pool(impGeo.clone(),impMat,isMobile?16000:26000,false,true);P.imp.m.geometry.boundingSphere=null;
PROP_KEYS.forEach(k=>{P.props.push(new Pool(GEO[k],MAT[PROP_MAT(k)],k.startsWith('rock')?1500:600,true));});
P.propsLo=[0,1,2].map(k=>new Pool(GEO[PROP_KEYS[k]+'_lo'],MAT.rock,4000,false));
function dropPools(list){for(const p of list){scene.remove(p.m);p.m.dispose();}list.length=0;}
// Switch biome: forget every tile, rebuild the species/ground pools for this mountain and re-bake the impostors.
// game.js has already removed the old tiles' groups; populateTile is then called afresh.
// setMountain may be called by game.js (always resets) or lazily by populateTile on first use.
let setP=null,setId=null;
export function setMountain(id){setId=id;gen++;tiles.clear();for(const j of qHi.splice(0).concat(qLo.splice(0)))j.res(j.msg.op==='tile'?{trees:new Float32Array(0),props:new Float32Array(0),col:new Float32Array(0)}:null);return setP=texReady.then(()=>doSetMountain(id));}
const biomeOf=id=>{const m=MOUNTAINS.find(q=>q.id===id);return m&&m.biome||id;};
// Razorback's high-alpine biome uses the Widowmaker species (larch, krummholz, stunted fir, whitebark) and ground set,
// placed far more sparsely by flora_worker.js; only the lichen on boulders differs
async function doSetMountain(id){if(id!==setId)return;const bio=biomeOf(id),set=SETS[bio]||SETS.ridgeline;tiles.clear();
 for(const p of[P.imp,...P.props,...P.propsLo]){p.begin();p.end(0,0,0,1);}
 if(mtnId!==bio){const t=performance.now();mtnId=bio;SET=set;let tg=0;MAT.rock.userData.u.uMoss.value=bio==='desert'?0:bio==='widowmaker'?.4:bio==='alpine'?.18:1;
  dropPools(P.full);dropPools(P.lite);dropPools(P.liteS);dropPools(P.ground);
  set.forEach(k=>{const m=MAT[TREE_MAT_OF(k)];P.full.push(new Pool(geo(k),m,isMobile?160:260,true));P.liteS.push(new Pool(geo(k+'_l'),m,isMobile?400:700,true));P.lite.push(new Pool(geo(k+'_l'),m,isMobile?500:900,false));});
  const gm=GROUND_BY[bio==='alpine'?'widowmaker':bio]||GROUND_BY.ridgeline;GROUND_KEYS.forEach(k=>{const [g,m]=gm[k];P.ground.push(new Pool(geo(g),MAT[m],GROUND_CAP[k],false));});
  T_SETGEO=performance.now()-t;bakeImpostors(set);T_BAKE=performance.now()-t-T_SETGEO;}
 else{for(const p of[...P.full,...P.lite,...P.liteS,...P.ground]){p.begin();p.end(0,0,0,1);}}
 for(const k in last)last[k].x=1e9;dirtyTrees=dirtyGround=dirtyProps=true;STAT.tiles=STAT.trees=STAT.props=STAT.genMs=STAT.gTiles=STAT.gGenMs=0;}

// ───────────────────────── per-frame selection
const cam={x:0,y:0,z:0,fx:0,fz:-1,cos:-1},last={t:{x:1e9,z:0,fx:0,fz:0,time:0},i:{x:1e9,z:0,fx:0,fz:0},g:{x:1e9,z:0,fx:0,fz:0},p:{x:1e9,z:0,fx:0,fz:0}};
const STAT={tiles:0,trees:0,props:0,genMs:0,gTiles:0,gGenMs:0,rebuildMs:0,rebuilds:0};
const _m4=new THREE.Matrix4(),_q=new THREE.Quaternion(),_e=new THREE.Euler(),_v=new THREE.Vector3(),_s=new THREE.Vector3(),_fw=new THREE.Vector3();
const moved=(L,dist,ang)=>Math.hypot(cam.x-L.x,cam.z-L.z)>dist||(cam.fx*L.fx+cam.fz*L.fz)<Math.cos(ang);
const mark=L=>{L.x=cam.x;L.z=cam.z;L.fx=cam.fx;L.fz=cam.fz;};
// in view? horizontal cone (camera hfov + margin), always true close by
function inView(dx,dz,d2,alw2,cosA){if(d2<alw2)return true;const d=Math.sqrt(d2);return dx*cam.fx+dz*cam.fz>d*cosA;}
function tileNear(T,rad){const dx=Math.max(0,Math.abs(cam.x-T.cx)-TILE/2),dz=Math.max(0,Math.abs(cam.z-T.cz)-TILE/2);return dx*dx+dz*dz<rad*rad;}
function rebuildTrees(){const cosA=cam.cos,alw2=R.always*R.always,f2=R.full*R.full,l2=R.lite*R.lite,ls2=R.liteSh*R.liteSh;
 for(const p of P.full)p.begin();for(const p of P.lite)p.begin();for(const p of P.liteS)p.begin();
 for(const T of tiles.values()){if(!tileNear(T,R.lite))continue;const a=T.trees;
  for(let k=0;k<a.length;k+=T_STRIDE){const dx=a[k]-cam.x,dz=a[k+2]-cam.z,d2=dx*dx+dz*dz;if(d2>=l2||!inView(dx,dz,d2,alw2,cosA))continue;
   const sp=a[k+5],pool=d2<f2?P.full[sp]:d2<ls2?P.liteS[sp]:P.lite[sp];pool.y(a[k],a[k+1],a[k+2],a[k+3],a[k+4],a[k+4],a[k+6],a[k+7],a[k+8]);}}
 for(const p of P.full)p.end(cam.x,cam.y,cam.z,R.full+25);for(const p of P.liteS)p.end(cam.x,cam.y,cam.z,R.liteSh+25);for(const p of P.lite)p.end(cam.x,cam.y,cam.z,R.lite+25);}
function rebuildImp(){const thin=(isMobile?170:240)*(mtnId==='shoreline'?.75:1),minKeep=mtnId==='shoreline'?.16:.3;const cosA=Math.cos(Math.min(Math.PI,Math.acos(cam.cos)+.35)),l2=R.lite*R.lite,p=P.imp;p.begin();
 for(const T of tiles.values()){const a=T.trees;
  // whole tile behind the camera? skip it
  const tx=T.cx-cam.x,tz=T.cz-cam.z,td=Math.hypot(tx,tz);if(td>60&&tx*cam.fx+tz*cam.fz<td*cosA-46)continue;
  for(let k=0;k<a.length;k+=T_STRIDE){const dx=a[k]-cam.x,dz=a[k+2]-cam.z,d2=dx*dx+dz*dz;if(d2<l2)continue;const d=Math.sqrt(d2);if(dx*cam.fx+dz*cam.fz<d*cosA)continue;
   // thin the far forest (fill-rate): keep ~(thin/d)² of the trees, a little larger, so the canopy still reads as closed
   let sc=a[k+4];if(d>thin){const keep=Math.max(minKeep,thin*thin/d2),u=(a[k+3]*7.137)%1;if(u>keep)continue;sc*=Math.min(1.3,1/Math.sqrt(keep)*.85+.15);}
   p.y(a[k],a[k+1],a[k+2],0,sc,sc,a[k+6],a[k+7],a[k+8],(a[k+5]+.001)*(a[k+3]>3.14?-1:1));}}
 p.end(cam.x,cam.y,cam.z,1000);}
function rebuildGround(){const cosA=Math.cos(Math.min(Math.PI,Math.acos(cam.cos)+.15)),alw2=36;
 for(const p of P.ground)p.begin();const maxR=Math.max(...GROUND_R),cs=TILE/SUB;
 for(const T of tiles.values()){if(!T.ground||!tileNear(T,maxR))continue;const x0=T.i*TILE,z0=T.j*TILE;
  for(let k=0;k<GROUND_KEYS.length;k++){const a=T.ground.ground[k],o=T.ground.offs[k],rr=GROUND_R[k],r2=rr*rr,pool=P.ground[k];
   for(let c=0;c<SUB*SUB;c++){const n0=o[c],n1=o[c+1];if(n0===n1)continue;const ccx=x0+(c%SUB+.5)*cs,ccz=z0+(Math.floor(c/SUB)+.5)*cs;
    const ex=Math.max(0,Math.abs(cam.x-ccx)-cs/2),ez=Math.max(0,Math.abs(cam.z-ccz)-cs/2);if(ex*ex+ez*ez>r2)continue;
    for(let q=n0*G_STRIDE;q<n1*G_STRIDE;q+=G_STRIDE){const dx=a[q]-cam.x,dz=a[q+2]-cam.z,d2=dx*dx+dz*dz;if(d2>r2||!inView(dx,dz,d2,alw2,cosA))continue;
     pool.y(a[q],a[q+1],a[q+2],a[q+3],a[q+4],a[q+5],a[q+6],a[q+7],a[q+8]);}}}}
 P.ground.forEach((p,k)=>p.end(cam.x,cam.y,cam.z,GROUND_R[k]+10));}
function rebuildProps(){const cosA=Math.cos(Math.min(Math.PI,Math.acos(cam.cos)+.3)),alw2=R.always*R.always,n2=R.rockHi*R.rockHi;for(const p of P.props)p.begin();for(const p of P.propsLo)p.begin();
 for(const T of tiles.values()){if(!tileNear(T,R.boulders))continue;const a=T.props;
  for(let k=0;k<a.length;k+=P_STRIDE){const kind=a[k+7],rr=kind<3?R.boulders:R.props;const dx=a[k]-cam.x,dz=a[k+2]-cam.z,d2=dx*dx+dz*dz;if(d2>rr*rr||!inView(dx,dz,d2,alw2,cosA))continue;
   if(kind<3&&d2>n2&&a[k+6]<Math.sqrt(d2)*(isMobile?.0048:.0034))continue;   // far away only the big boulders
   _e.set(a[k+3],a[k+4],a[k+5],a[k+11]?'YXZ':'XYZ');_q.setFromEuler(_e);_m4.compose(_v.set(a[k],a[k+1],a[k+2]),_q,_s.setScalar(a[k+6]));(kind<3&&d2>n2?P.propsLo[kind]:P.props[kind]).mat(_m4,a[k+8],a[k+9],a[k+10]);}}
 P.props.forEach((p,k)=>p.end(cam.x,cam.y,cam.z,(k<3?R.rockHi:R.props)+20));P.propsLo.forEach(p=>p.end(cam.x,cam.y,cam.z,R.boulders+20));}

export function updateFlora(dt,now,camera,riderPos){U.uTime.value=now/1000;if(riderPos)U.uRider.value.copy(riderPos);if(!camera)return;
 camera.getWorldDirection(_fw);let fx=_fw.x,fz=_fw.z;const fl=Math.hypot(fx,fz);if(fl<1e-3){fx=0;fz=-1;}else{fx/=fl;fz/=fl;}
 cam.x=camera.position.x;cam.y=camera.position.y;cam.z=camera.position.z;cam.fx=fx;cam.fz=fz;
 const hf=Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov/2))*camera.aspect);cam.cos=Math.cos(Math.min(Math.PI,hf+.45));
 const t0=performance.now();let did=false;
 if(dirtyTrees||moved(last.t,2,.09)){rebuildTrees();mark(last.t);did=true;}
 if(dirtyTrees||moved(last.i,8,.2)){rebuildImp();mark(last.i);did=true;}
 dirtyTrees=false;
 if(dirtyGround||moved(last.g,1.2,.09)){rebuildGround();mark(last.g);dirtyGround=false;did=true;}
 if(dirtyProps||moved(last.p,5,.15)){rebuildProps();mark(last.p);dirtyProps=false;did=true;}
 if(did){STAT.rebuildMs+=performance.now()-t0;STAT.rebuilds++;}}
export function floraStats(){const vis=o=>o.m.visible?o.m.count:0;const tri=o=>o.m.visible?o.m.count*o.m.geometry.index.count/3:0;
 const sum=(a,f)=>a.reduce((s,o)=>s+f(o),0);
 return {mtn:mtnId,setId,gen,qHi:qHi.length,qLo:qLo.length,inflight:wPending.size,nWorkers:workers.length,busy:workers.map(w=>w.busy).join('/'),species:SET.join(','),liveTiles:tiles.size,geoMs:T_GEO,setGeoMs:T_SETGEO,bakeMs:T_BAKE,...STAT,pools:{full:sum(P.full,vis),liteShadow:sum(P.liteS,vis),lite:sum(P.lite,vis),imp:vis(P.imp),ground:Object.fromEntries(GROUND_KEYS.map((k,i)=>[k,vis(P.ground[i])])),props:sum(P.props,vis),propsLo:sum(P.propsLo,vis)},
  tris:{full:sum(P.full,tri),liteS:sum(P.liteS,tri),lite:sum(P.lite,tri),imp:tri(P.imp),ground:sum(P.ground,tri),props:sum(P.props,tri),propsLo:sum(P.propsLo,tri)},
  draws:[...P.full,...P.lite,...P.liteS,P.imp,...P.ground,...P.props,...P.propsLo].filter(o=>o.m.visible).length};}
