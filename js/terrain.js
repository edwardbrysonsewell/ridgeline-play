// terrain.js — textured, LOD'd ground for the mountains.
// API used by game.js:
//   terrainReady: Promise           resolves when the ground textures are bound (placeholders until then)
//   setMountain(id)                 → Promise; switch the ground look and the workers' world (call after terrainfn.setMountain)
//   buildTerrainTile(i,j,lod)       → Promise<Mesh>; tile covers x∈[i*TILE,(i+1)*TILE], z∈[j*TILE,(j+1)*TILE]
//                                     lod 0 (nearest, < ~110 m) … 3 (farthest, > ~700 m)
//   disposeTerrainTile(obj)         frees GPU memory for a tile game.js removed from the scene
// Geometry is generated off the main thread by js/terrain_worker.js (a small pool of module Workers, fed from a
// priority queue: finer LODs first); if Workers are unavailable the same code runs on the main thread.
//
// Look: material layers, weighted per vertex by terrainfn.surfaceInto (the same weights the physics uses for grip),
// height-blended per pixel, with a per-mountain treatment selected by the MTN define:
//   0 Ridgeline  dirt · meadow grass · needle forest floor · granite
//   1 Widowmaker grey alpine dirt · sparse grass over gravel · scree/talus fans under cliffs · lichen slabs,
//                stratified cliff faces · old snow in high hollows
//   3 Desert     red/orange/cream sandstone with strata and desert varnish · crumbly red dirt · sandy washes · dry grass
//   2 Shoreline  everything wet: dark glossy singletrack with roots and puddles · moss & fern rainforest floor ·
//                mossy rock
//   5 Highland   (Hollowfell) dark, wet loam singletrack with roots · tawny moor grass and heather up top · moss and
//                needle duff under the conifers · dark wet rock with moss on its tops
//   4 Alpine     (Razorback) brown alpine loam with roots on the forest trails · tundra turf up high, greener below · pale
//                jointed granite on the faces (black water streaks, lichen) · scree fans under cliffs · snow lying in
//                shaded hollows, couloirs and ledges, thinning below a snowline
// Textures (tools/terrain_gen.py): array layers 0 dirt · 1 grass · 2 forest · 3 rock · 4 scree · 5 moss
//   tAlb 1024² sRGB albedo (<layer>_a.jpg) · tNrm 512² RG normal XY + B height (<layer>_n.jpg) · tNoise 256² RGBA fbm
import * as THREE from 'three';
import {TILE,isMobile,MOUNTAIN} from './core.js';
import {buildTileData} from './terrain_worker.js';

// ════════════════════════════════════════════════════════════════════════════ textures
const LAYERS=['dirt','grass','forest','rock','scree','moss','sandstone'];
const MEAN=[[134,103,74],[84,89,43],[93,70,45],[100,96,90],[117,113,107],[46,55,21],[165,112,83]];
function arrayTex(data,size,srgb,mips){
 const t=new THREE.DataArrayTexture(data,size,size,LAYERS.length);
 t.format=THREE.RGBAFormat;t.type=THREE.UnsignedByteType;t.wrapS=t.wrapT=THREE.RepeatWrapping;
 t.magFilter=THREE.LinearFilter;t.minFilter=mips?THREE.LinearMipmapLinearFilter:THREE.LinearFilter;t.generateMipmaps=!!mips;
 t.anisotropy=mips?(isMobile?4:8):1;if(srgb)t.colorSpace=THREE.SRGBColorSpace;t.needsUpdate=true;return t;}
const U_TEX={
 tAlb:{value:arrayTex(new Uint8Array(LAYERS.flatMap((_,i)=>[...MEAN[i],255])),1,true,false)},
 tNrm:{value:arrayTex(new Uint8Array(LAYERS.flatMap(()=>[128,128,128,255])),1,false,false)},
 tNoise:{value:(()=>{const t=new THREE.DataTexture(new Uint8Array([128,128,128,128]),1,1);t.needsUpdate=true;return t;})()}};
async function decode(url,size){
 const r=await fetch(url);if(!r.ok)throw new Error('terrain texture '+url+' '+r.status);
 const bmp=await createImageBitmap(await r.blob(),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
 const c=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(size,size):Object.assign(document.createElement('canvas'),{width:size,height:size});
 const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(bmp,0,0,size,size);bmp.close&&bmp.close();
 return x.getImageData(0,0,size,size).data;}
export const terrainReady=(async()=>{
 try{
  const AS=1024,NS=512;
  const [al,nm,nz]=await Promise.all([
   Promise.all(LAYERS.map(n=>decode('tex/terrain/'+n+'_a.jpg',AS))),
   Promise.all(LAYERS.map(n=>decode('tex/terrain/'+n+'_n.jpg',NS))),
   new Promise((res,rej)=>new THREE.TextureLoader().load('tex/terrain/noise.png',res,undefined,rej))]);
  const A=new Uint8Array(AS*AS*4*LAYERS.length);al.forEach((d,i)=>A.set(d,i*AS*AS*4));
  const N=new Uint8Array(NS*NS*4*LAYERS.length);nm.forEach((d,i)=>N.set(d,i*NS*NS*4));
  U_TEX.tAlb.value=arrayTex(A,AS,true,true);U_TEX.tNrm.value=arrayTex(N,NS,false,true);
  nz.wrapS=nz.wrapT=THREE.RepeatWrapping;nz.colorSpace=THREE.NoColorSpace;nz.anisotropy=4;nz.needsUpdate=true;U_TEX.tNoise.value=nz;
 }catch(e){console.warn('terrain textures unavailable, using flat colours',e);}
})();

// ════════════════════════════════════════════════════════════════════════════ material
const MTN_ID={ridgeline:0,widowmaker:1,shoreline:2,desert:3,alpine:4,highland:5};
const biomeOf=()=>MTN_ID[MOUNTAIN.biome||MOUNTAIN.id]||0;
const terrainMat=new THREE.MeshStandardMaterial({roughness:.95,metalness:0});
terrainMat.defines={TERRAIN_HQ:isMobile?0:1,MTN:biomeOf()};
const VERT_PARS=`
attribute vec4 aS;   // surface weights: dirt, grass, forest floor, rock (terrainfn.surfaceInto)
attribute vec4 aM;   // ambient occlusion, aspen share, feature core (packed dirt), forest density
attribute vec4 aX;   // talus (scree fan below a cliff), hollow (concavity ~8 m), trail heading, braking bumps
attribute vec4 aT;   // carved trail: lateral position (half-widths/16+½), tread, uphill cut bank, berm wall
varying vec4 vS;varying vec4 vM;varying vec4 vX;varying vec4 vT;varying vec3 vWPos;varying vec3 vWN;`;
const FRAG_PARS=`
uniform mediump sampler2DArray tAlb;uniform mediump sampler2DArray tNrm;uniform sampler2D tNoise;
varying vec4 vS;varying vec4 vM;varying vec4 vX;varying vec4 vT;varying vec3 vWPos;varying vec3 vWN;
vec3 gPert;float gRough;float gAO;
float th1(float n){return fract(sin(n*127.1)*43758.5453);}
float th2(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
// roots: sinuous segments in 2.2 m cells; orient = preferred direction (0 → random), density 0..1
float roots(vec2 wp,vec2 orient,float dens,inout vec3 c,inout vec3 dp){
 float rootL=0.;vec2 q=wp*(1./2.2),qi=floor(q);
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 cc=qi+vec2(float(x),float(y));float h1=th2(cc),h2=th2(cc+7.1);
  if(h1>.55*dens)continue;
  float an=h2*6.2832;vec2 dir=vec2(cos(an),sin(an));
  if(dot(orient,orient)>.1){vec2 o=normalize(orient);float j=(h2-.5)*1.1;dir=vec2(o.x*cos(j)-o.y*sin(j),o.x*sin(j)+o.y*cos(j));}
  vec2 nr=vec2(-dir.y,dir.x);
  vec2 rel=(q-cc-vec2(th2(cc+3.3),th2(cc+5.9)))*2.2;
  float t=dot(rel,dir),dd=dot(rel,nr)+.09*sin(t*2.3+h1*20.)+.03*sin(t*7.+h2*9.);
  float wd=(.035+.03*h1)*smoothstep(1.9,1.,abs(t))*smoothstep(-.2,.4,sin(t*1.7+h2*11.)+.3);
  float r=1.-dd*dd/max(wd*wd,1e-5);
  if(r>0.&&wd>.006){float pr=sqrt(r);rootL=max(rootL,pr);dp+=vec3(nr.x,0.,nr.y)*(-dd/wd)*1.1;
   vec3 bark=vec3(.11,.075,.05)*(.6+.6*pr)*(.8+.4*sin(t*25.+h1*30.));bark=mix(bark,vec3(.26,.2,.15),pow(pr,5.)*.7);
   c=mix(c,bark,smoothstep(0.,.3,r));}}
 return rootL;}
vec4 lay(float L,vec2 uv,vec2 gx,vec2 gy,out vec2 n){
 vec3 q=textureGrad(tNrm,vec3(uv,L),gx,gy).rgb;n=q.xy*2.-1.;
 return vec4(textureGrad(tAlb,vec3(uv,L),gx,gy).rgb,q.b);}
// anti-tiling: two lookups at hashed offsets chosen by a low-frequency index, blended by height (after iq)
vec4 layAT(float L,vec2 uv,vec2 gx,vec2 gy,float k,out vec2 n){
#if TERRAIN_HQ
 float i=floor(k*6.),f=fract(k*6.);
 vec2 oa=vec2(th1(i),th1(i+17.3)),ob=vec2(th1(i+1.),th1(i+18.3));
 vec2 na,nb;vec4 a=lay(L,uv+oa,gx,gy,na),b=lay(L,uv+ob,gx,gy,nb);
 float w=smoothstep(.3,.7,f+(b.a-a.a)*.6);n=mix(na,nb,w);return mix(a,b,w);
#else
 return lay(L,uv+vec2(th1(floor(k*3.)),th1(floor(k*3.)+5.)),gx,gy,n);
#endif
}`;
const FRAG_MAIN=`
#include <color_fragment>
{
 vec3 wp3=vWPos;vec2 wp=wp3.xz;
 float dist=length(vViewPosition);
 vec3 Nw=normalize(vWN);
 float vao=vM.x,asp=vM.y,fcore=vM.z,fdens=vM.w,talus=vX.x,hollow=vX.y;
 vec4 nz1=texture(tNoise,wp*(1./110.));     // macro 110 m
 vec4 nz2=texture(tNoise,wp*(1./13.)+.31);  // meso 13 m
 vec4 nz3=texture(tNoise,wp*(1./3.3)+.7);   // detail 3.3 m
 float fadeN=1.-smoothstep(18.,110.,dist);
 float fadeT=smoothstep(30.,150.,dist)*.85;   // texture detail → layer mean colour with distance
 // ── weights: vertex weights roughened by noise, rock on any steep face
 vec4 w=vS;
 w*=vec4(.55+.9*nz3.r,.6+.8*nz2.g,.6+.8*nz2.b,.6+.8*nz3.a);
 w.y+=vS.x*(1.-fcore)*smoothstep(.45,.8,nz3.b*.7+nz2.a*.5)*.9;   // grass reclaiming loose dirt patches
 float steep=1.-smoothstep(.5,.72,Nw.y+(nz2.r-.5)*.12);
#if MTN==5
 w.w=max(w.w,steep*1.2*(1.-smoothstep(.4,.8,vS.x)));   // Hollowfell: steep dirt (built jumps, cut banks) stays dirt
#else
 w.w=max(w.w,steep*1.2);
#endif
 // carved trail: tread, berm walls and the uphill cut bank are dirt
 float tlat=(vT.x-.5)*16.,tal=abs(tlat),tread=vT.y,tcut=vT.z,tberm=vT.w;
 float tAng=(vX.z-.5)*6.2832;vec2 tDir=vec2(sin(tAng),-cos(tAng));
 float onT=max(tread,max(tberm,tcut*.85));
 if(onT>.01){w.x=max(w.x,onT*(1.-w.w*.5));w.yz*=1.-onT;}
 w=max(w,0.);w/=max(dot(w,vec4(1.)),1e-4);
 float wT=0.;
#if MTN==1 || MTN==3 || MTN==4
 // scree fans below cliffs and ledges take over the soft ground
 float tl=clamp(talus*1.5*(.55+.9*nz2.r)-.1,0.,1.)*(1.-fcore);
#if MTN==4
 tl*=(1.-smoothstep(0.,.4,onT))*smoothstep(.4,.8,talus);   // scree only under real cliffs: Razorback's steep plunges and its trails stay dirt and turf
#endif
 wT=tl*(w.x+w.y+w.z);w.xyz*=1.-tl;
#endif
 vec2 n;
 vec3 aD=vec3(0.),aG=vec3(0.),aF=vec3(0.),aR=vec3(0.),aT=vec3(0.);vec3 pD=vec3(0.),pG=vec3(0.),pF=vec3(0.),pR=vec3(0.),pT=vec3(0.);
 vec4 hh=vec4(0.);float hT=0.;
 vec2 uvW=wp*(1./2.2),gx=dFdx(uvW),gy=dFdy(uvW);
 float puddle=0.,rootL=0.,ttr=0.;
 // ── dirt
 if(w.x>.01){
  vec4 a=layAT(0.,wp*(1./2.5),gx*.88,gy*.88,nz2.a*.6+nz3.g*.4,n);
  float moist=clamp(fdens*.55+(1.-vao)*1.3+(nz2.r-.55)*.6,0.,1.);
  float loose=smoothstep(.75,.35,vS.x)*(1.-fcore);
  vec3 c=mix(a.rgb,vec3(.23,.135,.07),fadeT);
  c*=mix(vec3(1.),vec3(.86,.8,.74),fcore*.6);
  c=mix(c,vec3(dot(c,vec3(.33)))*vec3(1.18,1.08,.94)*1.22,loose*.5);
#if MTN==1
  c=mix(c,vec3(dot(c,vec3(.33)))*vec3(1.02,.98,.92),.55);          // grey glacial grit
#elif MTN==4
  c=mix(c,vec3(dot(c,vec3(.33)))*vec3(1.04,.97,.88),.22);          // alpine loam: brown, a little washed by the altitude
#elif MTN==5
  c*=vec3(.6,.5,.42);moist=clamp(moist+.3,0.,1.);                    // dark, wet highland loam
#elif MTN==2
  c*=vec3(.5,.43,.38);moist=1.;                                     // saturated dark loam
#elif MTN==3
  {vec2 n2;vec4 g=lay(4.,wp*(1./2.6),gx*.85,gy*.85,n2);           // loose crumbly red dirt with rubble
   float lum=dot(c,vec3(.33));c=vec3(lum)*vec3(1.42,.8,.56)*1.12;
   float cr=smoothstep(.35,.7,nz3.b*.6+nz2.g*.6-.1)*(1.-tread*.7);
   c=mix(c,g.rgb*vec3(1.5,.86,.62),cr*.8);n=mix(n,n2,cr*.8);a.a=mix(a.a,g.a,cr*.8);}
  moist=0.;
#endif
  c*=mix(vec3(1.),vec3(.6,.5,.43),moist*.6);
  c*=.9+.2*nz3.g;
  c=max(mix(vec3(dot(c,vec3(.3,.55,.15))),c,1.12+moist*.15),0.);
  vec3 dp=vec3(n.x,0.,n.y)*mix(1.,.45,fcore);
  // ── carved trail tread
  if(onT>.01){
   float line=exp(-tlat*tlat/(.5*.5))*tread;                          // tyre-polished centre
   float rut=exp(-pow((tal-.36)/.12,2.))*tread;                        // the two ruts
   float edgeL=smoothstep(.62,1.05,tal)*tread*(1.-tberm);              // loose dust and marbles on the edges
   vec3 pk=c*vec3(.82,.76,.7);                                         // packed, darker
   c=mix(c,pk,max(line*.7,tberm*.6));
   c*=1.-rut*.22;
   c=mix(c,vec3(dot(c,vec3(.33)))*vec3(1.16,1.06,.92)*1.25,edgeL*.55);
   dp*=mix(1.,.35,max(line,tberm*.7));
   // marbles: small stones rolled to the edges (scree layer, near only)
   if(edgeL>.05&&dist<40.){vec2 n3;vec4 mb=lay(4.,wp*(1./1.6),gx*1.4,gy*1.4,n3);float mk=smoothstep(.45,.65,mb.a+(nz3.r-.5)*.5)*edgeL;
    c=mix(c,mb.rgb*mix(vec3(1.),vec3(1.3,.8,.6),float(MTN==3)),mk);dp=mix(dp,vec3(n3.x,0.,n3.y),mk);a.a=mix(a.a,mb.a,mk);}
   // braking bumps across the line before turns and drops
   float br=vX.w*tread*smoothstep(1.1,.3,tal)*(1.-smoothstep(10.,45.,dist));
   if(br>.01){float ph=dot(wp,tDir)*(6.2832/.8)+nz3.b*6.+tlat*.6;dp+=vec3(tDir.x,0.,tDir.y)*cos(ph)*.5*br;c*=1.-br*.1*(sin(ph)*.5+.5);}
   // uphill cut bank: raw subsoil, stones and roots in the wall
   c=mix(c,c*vec3(.7,.62,.56)*(.85+.3*nz3.a),tcut*.8);
   dp+=vec3(n.x,0.,n.y)*tcut*.8;
   ttr=line*.6+tberm*.3;
#if MTN==0 || MTN==4 || MTN==5
   if(fdens>.2&&dist<60.)rootL=max(rootL,roots(wp,vec2(-tDir.y,tDir.x)*tread,smoothstep(.2,.6,fdens)*(.6+.6*tcut),c,dp));
#endif
  }
#if MTN==2
  rootL=roots(wp,vec2(0.),1.,c,dp);
  // puddles in ruts and hollows: dark, mirror-smooth
  puddle=smoothstep(.62,.72,hollow*.55+nz3.r*.55+(1.-vao)*.6+(1.-a.a)*.35-rootL)*(1.-fcore*.5);
  c=mix(c,vec3(.035,.03,.025),puddle*.85);dp*=1.-puddle;
#endif
  aD=c;hh.x=a.a+rootL*.5-puddle*.3;pD=dp;
 }
 // ── grass
 if(w.y>.01){
  vec4 a=layAT(1.,wp*(1./2.1),gx*1.05,gy*1.05,nz2.a,n);a.rgb=mix(a.rgb,vec3(.085,.098,.024),fadeT);
  float dry=smoothstep(.45,.75,nz1.g)*.8;
#if MTN==1 || MTN==4
  // sparse alpine turf: grass only on the higher tufts, gravel between
  a.rgb*=mix(vec3(1.),vec3(1.25,1.1,.8),dry);
  vec2 n2;vec4 g=lay(4.,wp*(1./3.),gx*.73,gy*.73,n2);g.rgb=mix(g.rgb,vec3(.19,.18,.165),fadeT);
  float tuft=smoothstep(.3,.58,a.a+(nz3.g-.5)*.6+(nz2.b-.5)*.4);
#if MTN==4
  // Razorback: up high the turf is thin, tawny tundra between the stones; it greens up toward the valley
  {float lo=smoothstep(500.,2000.,-wp3.z);tuft*=smoothstep(.15,.55,lo+(nz1.g-.5)*.5);
   a.rgb=mix(vec3(dot(a.rgb,vec3(.33)))*vec3(1.45,1.18,.72),a.rgb,lo*.85);}
#endif
  a.rgb=mix(g.rgb,a.rgb,tuft);n=mix(n2*.8,n,tuft);a.a=mix(g.a*.6,a.a,tuft);
#elif MTN==2
  a.rgb*=vec3(.62,.78,.55);
#elif MTN==5
  // the moor: tawny purple-moor grass and heather patches up top, greener sheep-grazed grass lower down
  {float moor=1.-smoothstep(650.,1150.,-wp3.z);float lum=dot(a.rgb,vec3(.33));
   float hp=smoothstep(.45,.66,nz2.g*.7+nz1.b*.5+(nz3.r-.5)*.25);
   vec3 moorC=mix(vec3(lum)*vec3(1.55,1.22,.72),vec3(lum)*vec3(1.08,.7,.86)*.9,hp);
   a.rgb=mix(a.rgb*vec3(.78,.92,.68),moorC,moor*.9);}
#elif MTN==3
  // sparse dry bunch grass over red gravel
  a.rgb=mix(a.rgb,vec3(dot(a.rgb,vec3(.33)))*vec3(1.75,1.42,.8),.8);
  vec2 n2;vec4 g=lay(4.,wp*(1./3.),gx*.73,gy*.73,n2);g.rgb*=vec3(1.6,.95,.68);g.rgb=mix(g.rgb,vec3(.34,.19,.11),fadeT);
  float tuft=smoothstep(.42,.65,a.a+(nz3.g-.5)*.6+(nz2.b-.5)*.5);
  a.rgb=mix(g.rgb,a.rgb,tuft);n=mix(n2*.8,n,tuft);a.a=mix(g.a*.6,a.a,tuft);
#else
  a.rgb*=mix(vec3(1.),vec3(1.32,1.12,.78),dry)*(.85+.3*nz2.r);
#endif
  aG=a.rgb;hh.y=a.a;pG=vec3(n.x,0.,n.y)*.9;
 }
 // ── forest floor
 if(w.z>.01){
#if MTN==2
  vec4 a=layAT(5.,wp*(1./2.5),gx*.88,gy*.88,nz2.a+.37,n);a.rgb=mix(a.rgb,vec3(.03,.045,.012),fadeT);
  a.rgb*=(.8+.35*nz2.g)*mix(vec3(1.),vec3(.8,.62,.45),smoothstep(.55,.8,nz2.b)*.6);
#elif MTN==5
  // conifer floor: deep moss cushions with drifts of rust-brown needle duff (one moss lookup, the duff is a tint)
  vec4 a=layAT(5.,wp*(1./2.5),gx*.88,gy*.88,nz2.a+.37,n);a.rgb=mix(a.rgb,vec3(.035,.045,.015),fadeT);
  {float duff=smoothstep(.42,.7,nz2.b*.8+(nz3.g-.5)*.5);a.rgb*=(.85+.3*nz2.g);
   a.rgb=mix(a.rgb,vec3(dot(a.rgb,vec3(.33)))*vec3(1.7,1.05,.62),duff*.75);}
#else
  vec4 a=layAT(2.,wp*(1./2.5),gx*.88,gy*.88,nz2.a+.37,n);a.rgb=mix(a.rgb,vec3(.105,.06,.026),fadeT);
  a.rgb*=(.88+.24*nz2.g)*mix(vec3(1.),vec3(1.22,1.1,.7),asp*.6);
#endif
  aF=a.rgb;hh.z=a.a;pF=vec3(n.x,0.,n.y)*.9;
 }
 // ── rock: triplanar; side projections use v = world y so strata stay horizontal; anti-tiled on desktop
 if(w.w>.01){
  vec3 bw=pow(abs(Nw),vec3(4.));bw/=bw.x+bw.y+bw.z;
  vec3 p=wp3*(1./4.5);float rh=0.;float k=nz2.a*.5+nz1.b*.5;
#if MTN==3
  float RL=6.;p=wp3*(1./6.);
#elif MTN==4
  float RL=3.;p=wp3*(1./5.2);
#else
  float RL=3.;
#endif
  if(bw.x>.03){vec2 uv=p.zy;vec4 r=layAT(RL,uv,dFdx(uv),dFdy(uv),k,n);aR+=r.rgb*bw.x;rh+=r.a*bw.x;pR+=(vec3(0.,0.,sign(Nw.x))*n.x*sign(Nw.x)+vec3(0.,1.,0.)*n.y)*bw.x;}
  if(bw.y>.03){vec2 uv=p.xz;vec4 r=lay(RL,uv,dFdx(uv),dFdy(uv),n);aR+=r.rgb*bw.y;rh+=r.a*bw.y;pR+=(vec3(1.,0.,0.)*n.x+vec3(0.,0.,1.)*n.y)*bw.y;}
  if(bw.z>.03){vec2 uv=p.xy+.5;vec4 r=layAT(RL,uv,dFdx(uv),dFdy(uv),k+.31,n);aR+=r.rgb*bw.z;rh+=r.a*bw.z;pR+=(vec3(1.,0.,0.)*n.x+vec3(0.,1.,0.)*n.y)*bw.z;}
  aR=mix(aR,MTN==3?vec3(.34,.17,.1):vec3(.12,.112,.098),fadeT*.6);
  float vert=1.-smoothstep(.35,.75,abs(Nw.y));
#if MTN==4
  // granite has no bedding: massive pale rock cut by two joint sets, black water streaks down the faces, lichen on tops
  {vec4 jt=texture(tNoise,wp*(1./37.)+wp3.y*(1./97.));
   float j1=abs(fract(dot(wp,vec2(.8,.6))*(1./7.3)+jt.r*.7)-.5),j2=abs(fract(dot(wp,vec2(-.6,.8))*(1./11.)+jt.g*.6+wp3.y*(1./43.))-.5);
   float j3=abs(fract(wp3.y*(1./5.9)+jt.b*.8+dot(wp,vec2(.3,.2))*(1./30.))-.5);              // exfoliation sheets
   float jk=max(smoothstep(.03,.0,j1)*(.6+.4*jt.a),smoothstep(.022,.0,j2))*vert+smoothstep(.02,.0,j3)*smoothstep(.15,.55,vert)*.6;
   jk*=fadeN*.7+.3;
   aR=mix(aR,vec3(dot(aR,vec3(.33)))*vec3(1.07,1.03,.99),.45)*1.22*(.86+.28*jt.a);           // pale grey, warm feldspar
   aR*=1.-.6*jk;rh-=jk*.4;
   pR+=(vec3(.8,0.,.6)*(j1-.25)+vec3(-.6,0.,.8)*(j2-.25))*vert*.5*fadeN;
   vec2 hz=normalize(vec2(-Nw.z,Nw.x)+1e-4);float hc=dot(wp,hz);
   vec4 vs=texture(tNoise,vec2(hc*(1./3.7),wp3.y*(1./75.)));
   float stk=smoothstep(.52,.8,vs.r+(jt.b-.5)*.3)*vert*smoothstep(.25,.6,vs.g);
   aR=mix(aR,aR*vec3(.3,.29,.28),stk*.8);
   vec4 lc=texture(tNoise,wp3.xz*(1./.9)+wp3.y*.37);
   float li=smoothstep(.64,.71,lc.a)*smoothstep(.2,.8,Nw.y+.3);
   aR=mix(aR,mix(vec3(.45,.47,.33),vec3(.66,.4,.13),step(.62,lc.r)),li*.7);}
#else
  // strata: horizontal bands of tone and hardness following world height, slightly warped
  vec4 sb=texture(tNoise,vec2(wp3.y*(1./11.)+nz2.r*.15,wp.x*(1./700.)+wp.y*(1./900.)));
  aR*=mix(1.,.8+.42*sb.g,vert)*mix(vec3(1.),vec3(1.06,.98,.9),nz2.b)*(.85+.3*nz1.a)*mix(1.,.85,fdens);
  aR*=mix(1.,.72,vert*smoothstep(.62,.78,sb.b));                 // darker seams between beds
  // bedding: thin horizontal ribs and recessed seams catch the low sun on vertical faces
  {float ph=wp3.y*(6.2832/1.35)+sb.r*7.+nz3.g*1.5;float rib=sin(ph),rib2=sin(ph*2.7+sb.a*5.);
   pR+=vec3(0.,1.,0.)*(cos(ph)*.45+cos(ph*2.7+sb.a*5.)*.2)*vert*fadeN;
   aR*=1.+vert*(.1*rib+.05*rib2);
   float seam=smoothstep(.85,.97,sin(wp3.y*(6.2832/3.7)+sb.g*9.));aR*=1.-.45*seam*vert;rh-=seam*vert*.3;}
#endif
#if MTN==1
  aR=mix(aR,vec3(dot(aR,vec3(.33)))*vec3(1.08,1.06,1.03),.5)*1.12;   // pale alpine limestone-grey
  vec4 lc=texture(tNoise,wp3.xz*(1./.9)+wp3.y*.37);
  float li=smoothstep(.66,.72,lc.a)*smoothstep(.3,.8,Nw.y+.3);
  aR=mix(aR,mix(vec3(.5,.5,.38),vec3(.62,.38,.12),step(.6,lc.r)),li*.75);   // lichen crusts
#elif MTN==3
  // formation-scale colour: red / orange / cream members by elevation, desert varnish on faces
  {vec4 fm=texture(tNoise,vec2(wp3.y*(1./55.)+nz1.r*.2,wp.x*(1./3000.)));
   aR*=mix(vec3(1.),mix(vec3(1.12,.92,.82),vec3(1.06,1.08,1.12),smoothstep(.55,.75,fm.g)),.6)*mix(1.,.8,smoothstep(.6,.8,fm.b));
   vec2 hz=normalize(vec2(-Nw.z,Nw.x)+1e-4);float hc=dot(wp,hz);
   vec4 vs=texture(tNoise,vec2(hc*(1./5.),wp3.y*(1./90.)));
   float varn=smoothstep(.5,.8,vs.r+(fm.a-.5)*.4)*vert*smoothstep(.2,.6,vs.g);
   aR=mix(aR,aR*vec3(.32,.24,.2),varn*.75);}
  aR=mix(aR,aR*vec3(1.1,1.05,1.),fadeT*.3);
#elif MTN==2 || MTN==5
  float mo=smoothstep(.45,.8,Nw.y+(nz3.g-.5)*.5)*smoothstep(.35,.6,nz2.g+fdens*.3)*(MTN==5?.75:1.);
  aR*=.62;aR=mix(aR,vec3(.05,.085,.02)*(.7+.6*nz3.b),mo);              // wet, moss on the tops
#endif
  hh.w=rh;pR*=1.3;
 }
#if MTN==1 || MTN==3 || MTN==4
 if(wT>.01){vec4 a=layAT(4.,wp*(1./3.),gx*.73,gy*.73,nz2.a+.6,n);a.rgb=mix(a.rgb,vec3(.19,.18,.165),fadeT);
#if MTN==3
  a.rgb*=vec3(1.5,.9,.66);
#endif
  aT=a.rgb*(.9+.2*nz2.g);hT=a.a;pT=vec3(n.x,0.,n.y);}
#endif
 // ── height blend
 vec4 b=w+hh*.45;float bT=wT+hT*.45;float m=max(max(max(b.x,b.y),max(b.z,b.w)),bT)-.22;
 vec4 wf=max(b-m,0.)*step(.0101,w);float wfT=max(bT-m,0.)*step(.0101,wT);
 float sw=max(dot(wf,vec4(1.))+wfT,1e-4);wf/=sw;wfT/=sw;
 vec3 col=aD*wf.x+aG*wf.y+aF*wf.z+aR*wf.w+aT*wfT;
 vec3 pert=pD*wf.x+pG*wf.y+pF*wf.z+pR*wf.w+pT*wfT;
 float H=dot(hh,wf)+hT*wfT;
#if MTN==2
 float rough=dot(wf,vec4(mix(.62,.52,fcore)-rootL*.1,.72,.8,.5));
 rough=mix(rough,.05,puddle*wf.x);
#elif MTN==3
 float rough=dot(wf,vec4(.96,.95,.95,.9))+wfT*.95;
#else
 float rough=dot(wf,vec4(mix(.94,.84,fcore),.88,.95,.86))+wfT*.9;
#endif
 rough-=ttr*.14*wf.x;
#if MTN==3
 // pale sandy washes in hollows and gullies
 {float swa=smoothstep(.45,.65,hollow*.8+(nz2.g-.5)*.5+(nz3.r-.5)*.2)*(1.-wf.w*.7)*(1.-tread)*smoothstep(.75,.9,Nw.y);
  if(swa>.001){vec3 sc=vec3(.74,.56,.4)*(.9+.15*nz3.g+.06*nz1.a);col=mix(col,sc,swa);pert*=1.-swa*.75;H=mix(H,.45,swa);}}
#endif
 // ── old snow in high hollows (Widowmaker)
#if MTN==1
 {float top=1.-smoothstep(350.,800.,-wp3.z);
  float sn=smoothstep(.66,.8,hollow*.7+(nz2.b-.5)*.5+(nz1.a-.5)*.6+(nz3.a-.5)*.15+H*.1)*top*smoothstep(.62,.8,Nw.y)*(1.-wf.w*.6)*(1.-smoothstep(0.,.3,onT))*smoothstep(1.6,3.,tal);
  if(sn>.001){vec3 sc=vec3(.86,.89,.95)*(.92+.1*nz3.g);sc=mix(sc,sc*vec3(.82,.78,.72),smoothstep(.5,.0,sn)*.6);   // dirty, wind-scoured edges
   col=mix(col,sc,sn);pert=mix(pert,pert*.15,sn);rough=mix(rough,.55,sn);H=mix(H,.5,sn);}}
#elif MTN==4
 // ── snow (Razorback): lies where the low sun can't reach — hollows, couloirs, slopes facing away from the sun, ledges
 // on the faces — patchy up high, thinning out below a snowline ~1.5 km down; never on the trail
 {float s=-wp3.z,alt=1.-smoothstep(700.,2100.,s);
  float shadeA=smoothstep(.05,-.35,dot(Nw.xz,vec2(.737,-.676)));          // aspect away from the sun (scaled by steepness)
  float lodge=smoothstep(.5,.78,Nw.y);                                    // nothing sticks much past ~55°
  float sn=smoothstep(.5,.7,hollow*.8+shadeA*.35+(nz2.b-.5)*.6+(nz1.a-.5)*.55+(nz3.a-.5)*.18+H*.08-(1.-alt)*.75)
   *lodge*(1.-wf.w*.25*(1.-shadeA))*(1.-smoothstep(0.,.3,onT))*smoothstep(1.8,3.2,tal);
  if(sn>.001){float edge=smoothstep(.0,.55,sn);
   vec3 sc=vec3(.9,.93,.98)*(.93+.08*nz3.g);sc=mix(sc*vec3(.8,.77,.72),sc,edge);   // dirty, thin, wind-scoured edges
   col=mix(col,sc,sn);pert=mix(pert,pert*.12+vec3(nz3.r-.5,0.,nz3.b-.5)*.08,sn);rough=mix(rough,.5,sn);H=mix(H,.55,sn);}}
#endif
 float far=smoothstep(60.,420.,dist);
 col*=mix(1.,.85+.3*nz1.r,.6*far+.25);
 float cav=mix(.72,1.,smoothstep(.15,.6,H));
 col*=mix(1.,cav,.5);
 gAO=vao*mix(1.,cav,.7);
 gPert=pert*mix(.35,1.,fadeN);gRough=rough+(1.-fadeN)*.04;
 diffuseColor.rgb=col;
}`;
terrainMat.onBeforeCompile=sh=>{
 Object.assign(sh.uniforms,U_TEX);
 sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\n'+VERT_PARS)
  .replace('#include <begin_vertex>','#include <begin_vertex>\nvS=aS;vM=aM;vX=aX;vT=aT;vWPos=(modelMatrix*vec4(position,1.)).xyz;vWN=normalize(mat3(modelMatrix)*normal);');
 sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\n'+FRAG_PARS)
  .replace('#include <color_fragment>',FRAG_MAIN)
  .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
  { vec3 N=normalize(vWN); vec3 p=gPert-N*dot(gPert,N); normal=normalize((viewMatrix*vec4(normalize(N+p),0.)).xyz); }`)
  .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=clamp(gRough,.04,1.);')
  .replace('#include <aomap_fragment>',`#include <aomap_fragment>
  reflectedLight.indirectDiffuse*=gAO;reflectedLight.indirectSpecular*=gAO*gAO;reflectedLight.directDiffuse*=mix(1.,gAO,.35);`);
};
terrainMat.customProgramCacheKey=()=>'ridgeline-terrain-mtn-'+terrainMat.defines.MTN+'-'+terrainMat.defines.TERRAIN_HQ;

// ════════════════════════════════════════════════════════════════════════════ geometry (workers)
const TOL=isMobile?.06:.04;           // LOD-0 height tolerance (m): phones trade a little accuracy for ~half the vertices
const pool=[];let useMain=false,epoch=0,nextId=1,curMtn=MOUNTAIN.id;
const queue=[];                       // jobs not yet posted: {i,j,lod,resolve,reject,epoch}
const inflight=new Map();             // id → job
const PER_WORKER=2;
const stats={n:[0,0,0,0],ms:[0,0,0,0],mainMs:0};
const EMPTY=()=>new THREE.Group();
function onResult(d){const p=inflight.get(d.id);if(!p)return;inflight.delete(d.id);p.w.load--;
 if(d.error)p.reject(new Error(d.error));
 else{stats.n[d.lod]++;stats.ms[d.lod]+=d.ms||0;p.resolve(p.epoch===epoch?toMesh(d):EMPTY());}
 pump();}
function pump(){
 while(queue.length){let w=null;for(const x of pool)if(x.load<PER_WORKER&&(!w||x.load<w.load))w=x;if(!w)return;
  const p=queue.shift();if(p.epoch!==epoch){p.resolve(EMPTY());continue;}
  const id=nextId++;p.w=w;w.load++;inflight.set(id,p);w.postMessage({id,i:p.i,j:p.j,lod:p.lod,mtn:curMtn,tol:TOL});}}
function startWorkers(){
 if(typeof Worker==='undefined'){useMain=true;return;}
 const n=Math.max(1,Math.min(3,(navigator.hardwareConcurrency||2)-1));
 try{for(let k=0;k<n;k++){const w=new Worker(new URL('./terrain_worker.js',import.meta.url),{type:'module'});w.load=0;
   w.onmessage=e=>onResult(e.data);
   w.onerror=e=>{e.preventDefault&&e.preventDefault();console.warn('terrain worker failed; building on the main thread');failover();};
   pool.push(w);}}
 catch(e){useMain=true;}}
function failover(){if(useMain)return;useMain=true;for(const w of pool)w.terminate();pool.length=0;
 const list=[...inflight.values(),...queue];inflight.clear();queue.length=0;for(const p of list)runMain(p);}
function runMain(p){setTimeout(()=>{if(p.epoch!==epoch){p.resolve(EMPTY());return;}
 try{globalThis.__TOL=TOL;const t=performance.now();const d=buildTileData(p.i,p.j,p.lod);stats.mainMs+=performance.now()-t;stats.n[p.lod]++;p.resolve(toMesh(d));}catch(e){p.reject(e);}},0);}
startWorkers();
function toMesh(d){
 const g=new THREE.BufferGeometry();
 g.setAttribute('position',new THREE.BufferAttribute(d.pos,3));
 g.setAttribute('normal',new THREE.BufferAttribute(d.nor,3,true));
 g.setAttribute('aS',new THREE.BufferAttribute(d.aS,4,true));
 g.setAttribute('aM',new THREE.BufferAttribute(d.aM,4,true));
 g.setAttribute('aX',new THREE.BufferAttribute(d.aX,4,true));
 g.setAttribute('aT',new THREE.BufferAttribute(d.aT,4,true));
 g.setIndex(new THREE.BufferAttribute(d.idx,1));
 g.boundingBox=new THREE.Box3(new THREE.Vector3(0,d.ymin-20,0),new THREE.Vector3(TILE,d.ymax,TILE));
 g.boundingSphere=g.boundingBox.getBoundingSphere(new THREE.Sphere());
 const m=new THREE.Mesh(g,terrainMat);m.position.set(d.i*TILE,0,d.j*TILE);m.receiveShadow=true;
 m.matrixAutoUpdate=false;m.updateMatrix();m.userData.terrainLod=d.lod;return m;}
export function buildTerrainTile(i,j,lod){
 return new Promise((resolve,reject)=>{const p={i,j,lod,resolve,reject,epoch,w:null};
  if(useMain||!pool.length){runMain(p);return;}
  // finer LODs (near the rider) go first; FIFO within a LOD (game.js already asks nearest-first)
  let k=queue.length;while(k>0&&queue[k-1].lod>lod)k--;queue.splice(k,0,p);pump();});}
export function disposeTerrainTile(o){o.traverse(c=>{if(c.geometry)c.geometry.dispose();});}
// Switch mountain: terrainfn.setMountain(id) must already have run on the main thread (game.js does that).
// Drops queued work for the old mountain, tells the workers, and switches the shader treatment.
export function setMountain(id){
 epoch++;curMtn=id;
 for(const p of queue.splice(0))p.resolve(EMPTY());
 for(const w of pool)w.postMessage({mtn:id});
 const v=biomeOf();if(terrainMat.defines.MTN!==v){terrainMat.defines.MTN=v;terrainMat.needsUpdate=true;}
 return Promise.resolve();}
export {terrainMat,stats as terrainStats};
