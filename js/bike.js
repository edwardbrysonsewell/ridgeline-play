import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {scene} from './world.js';
import {isMobile} from './core.js';
// ═════════════════════════════════════════════════════════════ bike & rider
// Everything is built procedurally at load: swept hydroformed tubes, lathed hubs, extruded plates,
// a skinned rider (one skeleton, two skinned meshes) and a full-face helmet. Static parts are merged
// per material per moving group, so the whole thing is ~25 draw calls.
// Coordinates (bikeBody space): forward −Z, up +Y, right +X; origin = ground contact between the wheels.

const V3=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z),X=V3(1,0,0),Y=V3(0,1,0),Z=V3(0,0,1),TAU=Math.PI*2;
const cl=(v,a,b)=>v<a?a:v>b?b:v,mix=(a,b,t)=>a+(b-a)*t,sstep=(a,b,x)=>{const t=cl((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const bump=(a,b,x)=>{const t=cl((x-a)/(b-a),0,1);return Math.sin(Math.PI*t);};
// piecewise-linear map
const pwl=(xs,ys,x)=>{if(x<=xs[0])return ys[0];for(let i=1;i<xs.length;i++)if(x<=xs[i])return mix(ys[i-1],ys[i],(x-xs[i-1])/(xs[i]-xs[i-1]));return ys[ys.length-1];};

// ───────────────────────── textures & materials
const TL=new THREE.TextureLoader();
function tex(n,{srgb=true,rep=false}={}){const t=TL.load('tex/bike/'+n);if(srgb)t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=isMobile?2:8;if(rep)t.wrapS=t.wrapT=THREE.RepeatWrapping;return t;}
const TX={frame:tex('frame.jpg'),tyre:tex('tyre.jpg',{rep:true}),rotor:tex('rotor.png'),chain:tex('chain.png',{rep:true}),rider:tex('rider.jpg'),helmet:tex('helmet.jpg')};
const PHYS_ONLY=['clearcoat','clearcoatRoughness','iridescence','iridescenceIOR','iridescenceThicknessRange','sheen','sheenColor','sheenRoughness'];
function phys(o){if(isMobile){const s={...o};for(const k of PHYS_ONLY)delete s[k];return new THREE.MeshStandardMaterial(s);}return new THREE.MeshPhysicalMaterial(o);}
const M={
 paint:phys({map:TX.frame,roughness:.34,metalness:.12,clearcoat:1,clearcoatRoughness:.05}),
 black:new THREE.MeshStandardMaterial({color:0x1d1d20,roughness:.38,metalness:.7}),
 rubber:new THREE.MeshStandardMaterial({color:0x161616,roughness:.86}),
 alloy:new THREE.MeshStandardMaterial({color:0xc4c7cb,roughness:.3,metalness:1}),
 gold:new THREE.MeshStandardMaterial({color:0xd6a352,roughness:.18,metalness:1}),
 accent:new THREE.MeshStandardMaterial({color:0xff5a1c,roughness:.3,metalness:.75}),
 tyre:new THREE.MeshStandardMaterial({map:TX.tyre,roughness:.92}),
 rotor:new THREE.MeshStandardMaterial({map:TX.rotor,alphaTest:.5,metalness:.95,roughness:.3,side:THREE.DoubleSide}),
 chain:new THREE.MeshStandardMaterial({map:TX.chain,metalness:.85,roughness:.38}),
 spring:phys({color:0xffc414,roughness:.28,metalness:.05,clearcoat:.8,clearcoatRoughness:.12}),
 body:new THREE.MeshStandardMaterial({map:TX.rider,roughness:.8}),
 helmet:phys({map:TX.helmet,roughness:.32,clearcoat:1,clearcoatRoughness:.06,side:THREE.DoubleSide}),
 lens:phys({color:0x2a2018,metalness:1,roughness:.05,iridescence:1,iridescenceIOR:1.75,iridescenceThicknessRange:[260,720]}),
};
if(isMobile){M.lens.color.set(0xd06a2a);}
// the helmet is an open shell: its inside reads as dark padding
M.helmet.onBeforeCompile=s=>{s.fragmentShader=s.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\n if(!gl_FrontFacing) diffuseColor.rgb*=0.07;');};

// First-person near cut: rider fragments closer than this to the camera are discarded (0 = off), so the
// shoulders / sleeves never smear across the lens of a camera placed just behind the head.
const NEAR_CUT={value:0};
// cloth flutter: the loose jersey body and sleeves ripple with speed (displaced along the normal before skinning)
const WIND={uWind:{value:0},uT:{value:0}};
M.body.onBeforeCompile=s=>{s.uniforms.uNearCut=NEAR_CUT;Object.assign(s.uniforms,WIND);
 s.vertexShader='uniform float uWind,uT;\n'+s.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
 {float m=0.;if(uv.x<.5&&uv.y>.5){float v=(uv.y-.5)*2.;m=smoothstep(.25,.32,v)*(1.-smoothstep(.5,.66,v));}
  else if(uv.x>.75&&uv.y>.5){float v=(uv.y-.5)*2.;m=.55*smoothstep(.15,.4,v)*(1.-smoothstep(.75,.9,v));}
  float w=sin(uT*29.+position.y*37.+position.x*23.)*.6+sin(uT*43.+position.z*31.-position.x*17.)*.4;
  transformed+=normal*(m*uWind*.0075*w);}`);
 s.fragmentShader='uniform float uNearCut;\n'+s.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\n if(length(vViewPosition)<uNearCut)discard;');};
// UV regions in the frame atlas (see tools/bike_tex.py)
const UVF={dt:[0,.75,1,1],tt:[0,.625,.5,.75],cs:[.5,.625,1,.75],low:[0,.5,.5,.625],ht:[.125,.25,.375,.375],plate:[.5,.375,1,.625]};
const PT={orange:[.125,.44],gloss:[.375,.44],paper:[.06,.31]};
// UV regions in the rider atlas
const UVR={torso:[0,.5,.5,1],leg:[.5,.5,.75,1],arm:[.75,.5,1,1],glove:[0,.25,.25,.5],shoe:[.25,.25,.5,.5],strap:[.5,.375,1,.5]};
const RP={black:[.06,.12],char:[.19,.12],paper:[.31,.12],orange:[.44,.12],teal:[.56,.12],grey:[.69,.12],dark:[.81,.12],skin:[.56,.31],brace:[.69,.28],braceW:[.69,.31],
 glove:[.06,.4],gloveDark:[.19,.4],cuff:[.06,.48],shoe:[.3,.42],sole:[.37,.27],heel:[.27,.46]};

// ───────────────────────── geometry helpers
const STATS={tris:0,calls:0};
function prep(g){for(const k in g.attributes)if(!['position','normal','uv','skinIndex','skinWeight'].includes(k))g.deleteAttribute(k);
 if(!g.attributes.normal)g.computeVertexNormals();
 if(!g.attributes.uv)g.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(g.attributes.position.count*2),2));
 if(!g.index){const n=g.attributes.position.count,a=new Uint32Array(n);for(let i=0;i<n;i++)a[i]=i;g.setIndex(new THREE.BufferAttribute(a,1));}
 g.clearGroups();return g;}
function uvPt(g,p){const a=g.attributes.uv;for(let i=0;i<a.count;i++)a.setXY(i,p[0],p[1]);return g;}
function uvRect(g,r){const a=g.attributes.uv;for(let i=0;i<a.count;i++)a.setXY(i,mix(r[0],r[2],a.getX(i)),mix(r[1],r[3],a.getY(i)));return g;}
// zero-length normals (poles, degenerate caps) turn into NaN in the shader, which bloom then smears across the screen
function fixNormals(g){const n=g.attributes.normal,p=g.attributes.position;if(!n)return g;
 for(let i=0;i<n.count;i++){const x=n.getX(i),y=n.getY(i),z=n.getZ(i),l=Math.hypot(x,y,z);if(!(l>1e-6))n.setXYZ(i,0,1,0);else if(Math.abs(l-1)>1e-3)n.setXYZ(i,x/l,y/l,z/l);}return g;}
// Suspension parts move without extra draw calls: a kit built with a skeleton is one SkinnedMesh per material, each
// part bound rigidly to the bone of the body it belongs to (kit.bone at add time), or blended between two bones
// along its length (hoses, the coil spring, the chain runs) via skinT.
function skinTo(g,b){const n=g.attributes.position.count,si=new Uint16Array(n*4),sw=new Float32Array(n*4);
 for(let i=0;i<n;i++){si[i*4]=b;sw[i*4]=1;}g.setAttribute('skinIndex',new THREE.BufferAttribute(si,4));g.setAttribute('skinWeight',new THREE.BufferAttribute(sw,4));return g;}
// weights by sweep ring: f(t) → [bone0, bone1, weight of bone1]; t = ring/n (sweeps without caps)
function skinT(g,n,seg,f){const c=g.attributes.position.count,W=seg+1,si=new Uint16Array(c*4),sw=new Float32Array(c*4);
 for(let k=0;k<c;k++){const[b0,b1,w]=f(Math.min(n,Math.floor(k/W))/n);si[k*4]=b0;si[k*4+1]=b1;sw[k*4]=1-w;sw[k*4+1]=w;}
 g.setAttribute('skinIndex',new THREE.BufferAttribute(si,4));g.setAttribute('skinWeight',new THREE.BufferAttribute(sw,4));return g;}
// bones are direct children of the kit's parent; bind pose = their transforms now
function skeletonOf(bones){for(const b of bones)b.updateMatrix();return new THREE.Skeleton(bones,bones.map(b=>b.matrix.clone().invert()));}
class Kit{constructor(bone=null){this.m=new Map();this.bone=bone;}
 add(mat,g,mx,uv){prep(g);if(mx)g.applyMatrix4(mx);if(uv)uvPt(g,uv);if(this.bone!=null&&!g.attributes.skinIndex)skinTo(g,this.bone);if(!this.m.has(mat))this.m.set(mat,[]);this.m.get(mat).push(g);return g;}
 build(parent,{shadow=true,off=null,skel=null}={}){const out=[];for(const[mat,gs]of this.m){const g=fixNormals(mergeGeometries(gs));if(off)g.translate(-off.x,-off.y,-off.z);g.computeBoundingSphere();
  const me=skel?new THREE.SkinnedMesh(g,mat):new THREE.Mesh(g,mat);if(skel){me.bind(skel,new THREE.Matrix4());me.frustumCulled=false;}
  me.castShadow=shadow&&mat!==M.rotor;me.receiveShadow=true;parent.add(me);out.push(me);STATS.tris+=g.index.count/3;STATS.calls++;}
  this.m.clear();return out;}}
const _m4=new THREE.Matrix4();
function between(a,b){const d=b.clone().sub(a),L=d.length();return new THREE.Matrix4().compose(a.clone().addScaledVector(d,.5),new THREE.Quaternion().setFromUnitVectors(Y,d.divideScalar(L)),V3(1,L,1));}
function at(p,rx=0,ry=0,rz=0,s=1){return new THREE.Matrix4().compose(p,new THREE.Quaternion().setFromEuler(new THREE.Euler(rx,ry,rz)),typeof s==='number'?V3(s,s,s):s);}
function basisAt(o,x,y,z){return new THREE.Matrix4().makeBasis(x,y,z).setPosition(o);}
// a rod from a (radius ra) to b (radius rb)
function rod(kit,mat,a,b,ra,rb=ra,seg=10,uv){return kit.add(mat,new THREE.CylinderGeometry(rb,ra,1,seg,1),between(a,b),uv);}
function xcyl(kit,mat,c,r,len,seg=14,uv){return rod(kit,mat,c.clone().addScaledVector(X,-len/2),c.clone().addScaledVector(X,len/2),r,r,seg,uv);}
const CR=(pts,closed=false)=>new THREE.CatmullRomCurve3(pts,closed,'centripetal');
const lerpV=(a,b,t)=>a.clone().lerp(b,t);

// Sweep a (super)elliptic section along a curve.
// Section point = C + B·rx·S(φ) − N·ry·C(φ) (+ offsets); φ = 2π·v, v=0 → −N, .25 → +B, .5 → +N, .75 → −B.
// B is `ref` made orthogonal to the tangent (or parallel-transported when ref=null); N = T×B.
function sweep(curve,o={}){
 const n=o.n||24,seg=o.seg||12,prof=o.prof||(()=>({rx:.01})),ref=o.ref===undefined?X:o.ref,arc=o.arc||[0,1],uvr=o.uv||[0,0,1,1],closed=!!o.closed;
 const pos=[],nor=[],uv=[],idx=[];const P=V3(),T=V3(),B=V3(),N=V3(),pB=V3(),ta=V3(),tb=V3(),q=V3();let first=true;
 const pt=(t,out)=>{if(closed)t=((t%1)+1)%1;else t=cl(t,0,1);if(typeof curve==='function')return out.copy(curve(t));return curve.getPoint(t,out);};
 for(let i=0;i<=n;i++){const t=i/n;pt(t,P);pt(closed?t+.002:Math.min(1,t+.002),ta);pt(closed?t-.002:Math.max(0,t-.002),tb);T.subVectors(ta,tb).normalize();
  if(ref)B.copy(ref).addScaledVector(T,-ref.dot(T)).normalize();
  else if(first){const r0=Math.abs(T.x)<.9?X:Y;B.copy(r0).addScaledVector(T,-r0.dot(T)).normalize();}
  else B.copy(pB).addScaledVector(T,-pB.dot(T)).normalize();
  first=false;pB.copy(B);N.crossVectors(T,B).normalize();
  const p=prof(t,i);const rx=p.rx,ry=p.ry??p.rx,ex=2/(p.p||2),ox=p.ox||0,oy=p.oy||0;
  for(let j=0;j<=seg;j++){const f=mix(arc[0],arc[1],j/seg),a=f*TAU,S=Math.sin(a),C=Math.cos(a);
   const ss=Math.sign(S)*Math.abs(S)**ex,cc=Math.sign(C)*Math.abs(C)**ex;
   q.copy(P).addScaledVector(B,rx*ss+ox).addScaledVector(N,-ry*cc+oy);pos.push(q.x,q.y,q.z);
   const ns=Math.sign(S)*Math.abs(S)**(2-ex)/rx,nc=Math.sign(C)*Math.abs(C)**(2-ex)/ry;
   q.set(0,0,0).addScaledVector(B,ns).addScaledVector(N,-nc).normalize();nor.push(q.x,q.y,q.z);
   uv.push(mix(uvr[0],uvr[2],t),mix(uvr[1],uvr[3],o.uvAround==='local'?j/seg:f));}}
 const W=seg+1,flip=arc[1]<arc[0];
 for(let i=0;i<n;i++)for(let j=0;j<seg;j++){const a=i*W+j,b=a+W;if(flip)idx.push(a,b,a+1,a+1,b,b+1);else idx.push(a,a+1,b,a+1,b+1,b);}
 const caps=o.caps||[false,false];
 for(const [ci,end] of [[0,0],[1,n]]){if(!caps[ci])continue;const c0=pos.length/3;
  pt(end/n,P);pt(end/n+.002,ta);pt(end/n-.002,tb);T.subVectors(ta,tb).normalize();if(ci===0)T.negate();
  const pr=prof(end/n,end);const sh=V3();for(let j=0;j<seg;j++){const k=(end*W+j)*3;sh.x+=pos[k]/seg;sh.y+=pos[k+1]/seg;sh.z+=pos[k+2]/seg;}
  P.copy(sh).addScaledVector(T,(pr.capBulge||0));
  pos.push(P.x,P.y,P.z);nor.push(T.x,T.y,T.z);uv.push(uv[end*W*2],uv[end*W*2+1]);
  for(let j=0;j<seg;j++){const a=end*W+j;if((ci===1)!==flip)idx.push(a,a+1,c0);else idx.push(a+1,a,c0);}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
 g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);return g;}
const line=(a,b)=>t=>lerpV(a,b,t);
// lathe around the X axis; pts = [[radius, x], ...] in increasing x
function latheX(pts,seg=24){const g=new THREE.LatheGeometry(pts.map(p=>new THREE.Vector2(p[0],p[1])),seg);g.rotateZ(-Math.PI/2);return g;}
// convex hull of circles [[a,b,r]] in a 2D plane → point list
function hullCircles(cs,k=14){const pts=[];for(const[a,b,r]of cs)for(let i=0;i<k;i++){const t=i/k*TAU;pts.push([a+Math.cos(t)*r,b+Math.sin(t)*r]);}
 pts.sort((p,q)=>p[0]-q[0]||p[1]-q[1]);const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);const lo=[],up=[];
 for(const p of pts){while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p);}
 for(let i=pts.length-1;i>=0;i--){const p=pts[i];while(up.length>=2&&cr(up[up.length-2],up[up.length-1],p)<=0)up.pop();up.push(p);}
 up.pop();lo.pop();return lo.concat(up);}
const shapeOf=(pts,holes=[])=>{const s=new THREE.Shape(pts.map(p=>new THREE.Vector2(p[0],p[1])));for(const h of holes)s.holes.push(new THREE.Path(h.map(p=>new THREE.Vector2(p[0],p[1]))));return s;};
const circlePts=(cx,cy,r,k=24)=>{const o=[];for(let i=0;i<k;i++){const t=i/k*TAU;o.push([cx+Math.cos(t)*r,cy+Math.sin(t)*r]);}return o;};
// a plate lying in the bike's YZ plane: 2D points are (z, y); centred on x=xc with thickness th
function plateYZ(pts,xc,th,bevel=.002,holes=[]){const fl=p=>p.map(q=>[-q[0],q[1]]);
 const g=new THREE.ExtrudeGeometry(shapeOf(fl(pts),holes.map(fl)),{depth:th-bevel*2,bevelEnabled:bevel>0,bevelThickness:bevel,bevelSize:bevel,bevelSegments:1,curveSegments:6});
 g.applyMatrix4(new THREE.Matrix4().makeBasis(V3(0,0,-1),V3(0,1,0),V3(1,0,0)).setPosition(xc-th/2+bevel,0,0));return g;}

// ═════════════════════════════════════════════════════════════ geometry of the bike
const bike=new THREE.Group();bike.name='bike';scene.add(bike);
const bikeBody=new THREE.Group();bike.add(bikeBody);
const RA=V3(0,.39,.63),FA=V3(0,.39,-.67),BB=V3(0,.36,.10),WR=.39;
const HD=V3(0,.891,.454).normalize(),FWD=V3(0,HD.z,-HD.y);            // steering axis (63.0° head angle) and its forward normal
// FR lifts the head tube, crowns and cockpit along the steering axis so the fork has room for 220 mm of travel
// (tyre top to the lower crown's bridge ≥ 0.226 m along the legs); TRAVEL is the stroke at both ends
const FR=.082,TRAVEL=.22;
const HTB=FA.clone().addScaledVector(FWD,-.05);HTB.addScaledVector(HD,(.89+FR*HD.y-HTB.y)/HD.y);   // 50 mm fork offset
const axisPt=t=>HTB.clone().addScaledVector(HD,t);
const legPt=(t,sx=0)=>FA.clone().addScaledVector(HD,t).setX(sx);       // fork leg line, t = distance from the axle
const ST=V3(0,.96,.28),stAt=y=>BB.clone().addScaledVector(ST,(y-BB.y)/ST.y);
const CHX=.048;                                                        // chain line

// bones of the frame kit (children of bikeBody, posed in bike space by rearSuspension())
const FB={};['frame','swing','stays','rocker','shock','shockBody','chainTop','chainBot'].forEach((n,i)=>{const b=new THREE.Bone();b.name=n;b.userData.i=i;bikeBody.add(b);FB[n]=b;});
const fb=n=>FB[n].userData.i,CHN={};   // CHN: chain-run end points (bind pose)
const F=new Kit(fb('frame'));   // frame + rear end + shock + drivetrain, one skinned mesh per material
// ── front triangle
F.add(M.paint,sweep(line(axisPt(-.008),axisPt(.135)),{n:6,seg:28,uv:UVF.ht,prof:t=>{const r=mix(.0355,.031,t)+.003*(sstep(.12,0,t)+sstep(.88,1,t));return{rx:r,ry:r};}}));
for(const t of[-.016,.143])rod(F,M.black,axisPt(t-.009),axisPt(t+.009),.037,.037,24);
const DT=CR([axisPt(.04),V3(0,.776,-.21).addScaledVector(HD,FR*.55),   // bowed back: front tyre clearance at full travel
V3(0,.585,-.058).addScaledVector(HD,FR*.18),V3(0,.45,.045),BB.clone().add(V3(0,.01,.005))]);
F.add(M.paint,sweep(DT,{n:30,seg:24,uv:UVF.dt,prof:t=>({rx:mix(.03,.036,t),ry:mix(.044,.036,sstep(0,.45,t))+.012*sstep(.6,1,t),p:2.6})}));
F.add(M.rubber,sweep(DT,{n:12,seg:8,arc:[-.2,.2],prof:t=>({rx:.039,ry:.051,p:2.6})}),null).applyMatrix4(new THREE.Matrix4());
// down-tube guard only on the lower half (rebuilt for a sub-range)
F.m.get(M.rubber).pop();
F.add(M.rubber,sweep(t=>DT.getPoint(mix(.55,.97,t)),{n:10,seg:8,arc:[-.22,.22],prof:t=>{const u=mix(.55,.97,t);return{rx:mix(.03,.036,u)*1.08,ry:(.036+.012*sstep(.6,1,u))*1.08,p:2.6};}}));
const TT=CR([axisPt(.105),V3(0,.952,-.12).addScaledVector(HD,FR*.6),V3(0,.86,.08).addScaledVector(HD,FR*.22),stAt(.80)]);
F.add(M.paint,sweep(TT,{n:22,seg:16,uv:UVF.tt,prof:t=>({rx:mix(.023,.019,t),ry:mix(.032,.021,t),p:2.4})}));
F.add(M.paint,sweep(line(BB,stAt(.87)),{n:8,seg:16,prof:t=>({rx:mix(.024,.019,t),ry:mix(.026,.019,t),p:2.2})}),null,PT.orange);
rod(F,M.black,stAt(.855),stAt(.88),.0205,.0205,16);
rod(F,M.black,stAt(.86),stAt(.955),.0158,.0158,14);
// gussets: head-tube web and seat-tube/top-tube web
{const a=axisPt(.02),b=axisPt(.112),c=TT.getPoint(.22),d=DT.getPoint(.2);
 F.add(M.paint,plateYZ([[a.z,a.y],[b.z,b.y],[c.z,c.y-.012],[d.z,d.y+.015]],0,.026,.004),null,PT.orange);
 const e=stAt(.70),f2=stAt(.80),g2=TT.getPoint(.82);F.add(M.paint,plateYZ([[e.z,e.y],[f2.z,f2.y],[g2.z,g2.y]],0,.022,.004),null,PT.orange);}
xcyl(F,M.paint,BB,.0235,.088,20,PT.orange);
for(const s of[-1,1])xcyl(F,M.black,BB.clone().setX(s*.05),.021,.012,20);
// ── suspension: shock mounts, coil shock, rocker
// Rear end = four-bar: frame, swingarm (chainstays, MP→RA), seat stays (pivot concentric with the axle, RA→SSP),
// rocker (about PIV, carrying the seat-stay eye SSP and the shock's upper eye SU). Points chosen for a DH curve:
// leverage 2.8 at top-out easing to 2.6 and rising to 2.7 at the end, 82 mm of shock stroke for 220 mm of wheel
// travel, 47° of rocker swing; the seat-stay eye stays behind the seat tube and the rocker plates sit outboard of
// the tyre all the way through.
const SL=V3(0,.60,-.09),SU=V3(0,.77,.16),PIV=stAt(.67),SSP=V3(0,.73,.40),MP=V3(0,.465,.17);
const SHK={L0:SU.distanceTo(SL)};   // shock eye-to-eye at top-out
F.add(M.paint,plateYZ(hullCircles([[SL.z,SL.y,.017],[-.125,.555,.02],[-.04,.53,.02]]),0,.034,.004),null,PT.orange);
xcyl(F,M.alloy,SL,.0055,.046,8);
{const sd=SU.clone().sub(SL),sl=sd.length();sd.normalize();const Sp=f=>SL.clone().addScaledVector(sd,f);const up=V3().crossVectors(sd,X).normalize();
 // big-hit coil shock: 10.6 mm wire on a 71 mm coil (82 mm outside), fat body, a short fat piggyback reservoir
 // above the preload collar. The lower eye sits in a down-tube lug; a long shaft eyelet carries the spring seat 66 mm
 // up the shaft so the coil clears the down tube, and the stack leaves the coil 4 mm short of binding at 82 mm.
 // shaft side, rotating about the lower eye
 F.bone=fb('shock');
 xcyl(F,M.black,SL,.016,.04,18);
 rod(F,M.black,Sp(0),Sp(.068),.016,.016,16);                             // shaft eyelet
 rod(F,M.alloy,Sp(.06),Sp(.176),.0085,.0085,14);                          // shaft
 rod(F,M.black,Sp(.066),Sp(.076),.044,.044,28);                           // lower spring seat
 rod(F,M.black,Sp(.066),Sp(.069),.046,.046,28);
 rod(F,M.rubber,Sp(.146),Sp(.162),.015,.02,16);                           // bottom-out bumper
 // body side: slides down the shaft by the stroke
 F.bone=fb('shockBody');
 xcyl(F,M.black,SU,.015,.04,18);
 rod(F,M.black,Sp(.162),Sp(sl-.012),.0225,.0225,22);                      // damper body
 rod(F,M.alloy,Sp(.162),Sp(.17),.0238,.0238,22);                          // seal head
 rod(F,M.black,Sp(sl-.03),Sp(sl-.012),.026,.026,22);                      // eyelet head
 rod(F,M.accent,Sp(sl-.067),Sp(sl-.052),.045,.045,28);                    // preload collar
 rod(F,M.black,Sp(sl-.064),Sp(sl-.055),.0465,.0465,28);
 const RO=.056;
 rod(F,M.black,Sp(sl-.008).addScaledVector(up,RO),Sp(sl-.046).addScaledVector(up,RO),.022,.022,22);   // piggyback reservoir
 rod(F,M.gold,Sp(sl-.046).addScaledVector(up,RO),Sp(sl-.05).addScaledVector(up,RO),.0223,.0223,22);
 rod(F,M.black,Sp(sl-.024),Sp(sl-.024).addScaledVector(up,RO),.013,.013,12);                          // reservoir bridge
 rod(F,M.accent,Sp(sl-.02).addScaledVector(up,.028).add(V3(.022,0,0)),Sp(sl-.02).addScaledVector(up,.028).add(V3(.034,0,0)),.008,.008,12);  // rebound knob
 rod(F,M.accent,Sp(sl-.026).addScaledVector(up,RO+.022),Sp(sl-.026).addScaledVector(up,RO+.034),.009,.009,12);    // compression knob
 // coil: each turn blended between the two ends, so it compresses evenly and the wire stays round
 const coils=6,a0=.08,a1=sl-.07,Rs=.0355,n=Math.round(coils*24);
 F.add(M.spring,skinT(sweep(t=>{const th=t*coils*TAU;return Sp(mix(a0,a1,t)).addScaledVector(X,Math.cos(th)*Rs).addScaledVector(up,Math.sin(th)*Rs);},{n,seg:9,ref:null,prof:()=>({rx:.0053})}),n,9,t=>[fb('shock'),fb('shockBody'),t]));}
// rocker: a plate either side, outboard of the tyre (its rear arm passes within 2 cm of the tread at full travel);
// two arms from the pivot (shock eye forward, seat-stay eye rearward), spacers on the shock and pivot bolts
F.bone=fb('rocker');
{const RX=.05,mid=PIV.clone().lerp(SSP,.5).addScaledVector(V3(0,SSP.z-PIV.z,-(SSP.y-PIV.y)).normalize(),.01);
 for(const s of[-1,1]){F.add(M.black,plateYZ(hullCircles([[PIV.z,PIV.y,.024],[SU.z,SU.y,.019]]),s*RX,.009,.002));
  F.add(M.black,plateYZ(hullCircles([[PIV.z,PIV.y,.024],[mid.z,mid.y,.018],[SSP.z,SSP.y,.019]]),s*RX,.009,.002));
  rod(F,M.alloy,SU.clone().setX(s*.02),SU.clone().setX(s*(RX-.004)),.009,.009,12);
  rod(F,M.alloy,PIV.clone().setX(s*.025),PIV.clone().setX(s*(RX-.004)),.011,.011,12);}
 xcyl(F,M.alloy,SU,.0055,2*RX+.022,8);
 xcyl(F,M.alloy,PIV,.0068,2*RX+.02,10);for(const s of[-1,1])xcyl(F,M.black,PIV.clone().setX(s*(RX+.008)),.0105,.006,12);}
xcyl(F,M.alloy,SSP,.0068,.164,10);for(const s of[-1,1])xcyl(F,M.black,SSP.clone().setX(s*.08),.0105,.006,12);
F.bone=fb('frame');
F.add(M.paint,plateYZ(hullCircles([[PIV.z,PIV.y,.026],[stAt(.62).z-.008,.62,.02]]),0,.05,.004),null,PT.orange);  // rocker pivot lug
// ── rear triangle
// swingarm (chainstays, dropouts, axle) about MP; seat stays pivot on the axle (outboard of the dropouts) and
// run up to the rocker, outboard of its plates. No stay bridge: anywhere below SSP would be inside the tyre's sweep.
const SS=[],CS=[];
for(const s of[-1,1]){
 F.bone=fb('swing');
 const cs=CR([V3(s*.04,MP.y,MP.z),V3(s*.062,.447,.34),V3(s*.069,.41,.56),V3(s*.071,.392,.625)]);CS.push(cs);
 F.add(M.paint,sweep(cs,{n:22,seg:14,uv:UVF.cs,prof:t=>({rx:.0115,ry:mix(.027,.016,t),p:3.2})}));
 F.add(M.paint,plateYZ(hullCircles([[RA.z,RA.y,.027],[.585,.415,.02],[.6,.44,.018]]),s*.073,.012,.003),null,PT.orange);
 F.bone=fb('stays');
 const ss=CR([V3(s*.093,RA.y+.012,RA.z-.004),V3(s*.087,.52,.555),V3(s*.076,.635,.475),V3(s*.068,SSP.y,SSP.z)]);SS.push(ss);
 F.add(M.paint,sweep(ss,{n:20,seg:14,prof:t=>({rx:mix(.011,.012,t),ry:mix(.015,.017,t),p:2.4})}),null,PT.orange);
 F.add(M.paint,plateYZ(hullCircles([[RA.z,RA.y,.024],[RA.z-.012,RA.y+.03,.016]]),s*.093,.01,.003),null,PT.orange);
 F.bone=fb('swing');
 xcyl(F,M.black,RA.clone().setX(s*.105),.016,.01,16);
}
F.bone=fb('swing');
rod(F,M.paint,V3(-.045,MP.y,MP.z),V3(.045,MP.y,MP.z),.021,.021,18,PT.orange);
{const a=CS[0].getPoint(.25),b=CS[1].getPoint(.25);rod(F,M.paint,a,b,.012,.012,10,PT.orange);}
xcyl(F,M.alloy,RA,.0085,.22,12);
F.bone=fb('frame');
xcyl(F,M.alloy,MP,.0075,.11,10);for(const s of[-1,1])xcyl(F,M.black,MP.clone().setX(s*.052),.013,.007,14);
// ── brakes (rear caliper on the left seat stay) and cables
function caliper(kit,c,ctr,ang,xr,mountTo){ // c = rotor centre, caliper centred at polar angle `ang` (in the y,−z plane), on the rotor plane x=xr
 const arc=t=>{const a=ang+(t-.5)*.62;return V3(xr,c.y+Math.cos(a)*.094,c.z-Math.sin(a)*.094);};
 kit.add(M.black,sweep(arc,{n:6,seg:12,ref:X,caps:[true,true],prof:()=>({rx:.019,ry:.018,p:4})}));
 kit.add(M.gold,sweep(arc,{n:4,seg:10,ref:X,prof:()=>({rx:.0195,ry:.009,p:4,oy:.008})}));
 const m=arc(.5);if(mountTo)rod(kit,M.black,m.clone().setX(xr-.012),mountTo,.008,.01,8);
}
// the caliper rides the seat stay, which pivots about the axle, so it stays on the rotor through the travel
F.bone=fb('stays');caliper(F,RA,null,.9,-.06,SS[0].getPoint(.18).add(V3(.004,0,0)));F.bone=fb('frame');
// hoses: f(t) gives the bones along the hose (see skinT); blends happen where a hose crosses a pivot
const hose=(kit,pts,r=.0027,mat=M.rubber,f=null)=>{const n=Math.max(8,pts.length*8),g=sweep(CR(pts),{n,seg:6,ref:null,prof:()=>({rx:r})});if(f)skinT(g,n,6,f);return kit.add(mat,g);};
const along=(t,ks,bs)=>{for(let i=0;i<ks.length;i++)if(t<ks[i][1])return t<ks[i][0]?[bs[i],bs[i],0]:[bs[i],bs[i+1],sstep(ks[i][0],ks[i][1],t)];return[bs[bs.length-1],bs[bs.length-1],0];};
hose(F,[V3(-.075,.47,.57),V3(-.068,.49,.48),V3(-.058,.475,.34),V3(-.05,.49,.22),DT.getPoint(.8).add(V3(-.036,.012,0)),DT.getPoint(.45).add(V3(-.034,.02,0)),DT.getPoint(.12).add(V3(-.032,.03,.0)),axisPt(.06).add(V3(-.03,0,.02))],.0027,M.rubber,
 t=>along(t,[[0,1/7],[3/7,4/7]],[fb('stays'),fb('swing'),fb('frame')]));
hose(F,[V3(.085,.33,.672),V3(.09,.36,.70),V3(.08,.43,.62),V3(.066,.462,.42),V3(.058,.48,.24),DT.getPoint(.8).add(V3(.036,.012,0)),DT.getPoint(.45).add(V3(.034,.02,0)),DT.getPoint(.12).add(V3(.032,.03,.0)),axisPt(.06).add(V3(.03,0,.02))],.0025,M.black,
 t=>along(t,[[4/8,5/8]],[fb('swing'),fb('frame')]));
// ── drivetrain: bash guard, chain guide, derailleur, cassette pulley cage, chain
F.add(M.rubber,plateYZ(circlePts(BB.z,BB.y,.09,48),.066,.006,.0015,[circlePts(BB.z,BB.y,.072,40)]));
F.add(M.black,plateYZ(hullCircles([[BB.z+.045,BB.y+.08,.012],[BB.z+.075,BB.y+.06,.012]]),CHX,.022,.003));
const JU=V3(CHX,.345,.648),JL=V3(CHX,.29,.668),RING=.0647,COG=.0303;
F.bone=fb('swing');   // hanger, derailleur and cage hang off the dropout
{const hz=RA.z+.02;F.add(M.black,plateYZ(hullCircles([[RA.z,RA.y,.016],[hz,RA.y-.035,.012]]),.083,.007));
 F.add(M.black,sweep(CR([V3(.088,RA.y-.035,hz),V3(.094,RA.y-.045,hz+.03),V3(.085,RA.y-.05,hz+.035),V3(.074,JU.y+.012,JU.z+.008)]),{n:10,seg:10,ref:X,prof:t=>({rx:.011,ry:.016,p:3})}));
 for(const s of[-1,1])F.add(s>0?M.accent:M.black,plateYZ(hullCircles([[JU.z,JU.y,.02],[JL.z,JL.y,.02]]),CHX+s*.009,.004,.001));
 for(const j of[JU,JL]){xcyl(F,M.black,j,.016,.008,18);xcyl(F,M.alloy,j,.005,.024,8);}}
{const pts=[],C1=V3(CHX,BB.y,BB.z),C2=V3(CHX,RA.y,RA.z),r1=RING+.003,r2=COG+.003,P=(c,r,a)=>V3(CHX,c.y+Math.sin(a)*r,c.z+Math.cos(a)*r);
 // around the chainring's front half: top (a=π/2) → front (a=π) → bottom
 for(let i=0;i<=10;i++)pts.push(P(C1,r1,Math.PI/2+Math.PI*i/10));
 pts.push(V3(CHX,JL.y-.019,JL.z-.1));
 for(let i=0;i<=5;i++)pts.push(P(JL,.019,-Math.PI/2+Math.PI*.9*i/5));             // under & round the back of the lower jockey
 for(let i=0;i<=4;i++)pts.push(P(JU,.019,-Math.PI/2-Math.PI*.8*i/4));              // up the front of the upper jockey
 for(let i=1;i<=6;i++)pts.push(P(C2,r2,-Math.PI/2+Math.PI*i/6));                   // round the back of the cog to the top
 pts.push(V3(CHX,C2.y+r2,C2.z-.1));
 const curve=CR(pts,true);const len=curve.getLength(),N=pts.length;
 const g=sweep(curve,{n:260,seg:4,closed:true,ref:X,prof:()=>({rx:.0042,ry:.0045,p:5})});
 const a=g.attributes.uv;for(let i=0;i<a.count;i++)a.setX(i,a.getX(i)*len/.0254);
 // ring wrap on the frame, jockey + cog wrap on the swingarm, and the two free runs on bones that swing and
 // stretch each run from its chainring tangent to its (moving) far end. Point k of the closed curve is at t = k/N.
 skinT(g,260,4,t=>{const b=t<=10/N?fb('frame'):t<=12/N?fb('chainBot'):t<=28/N?fb('swing'):fb('chainTop');return[b,b,0];});
 Object.assign(CHN,{At:pts[0].clone(),Bt:pts[28].clone(),Ab:pts[10].clone(),Bb:pts[12].clone()});
 F.bone=fb('frame');F.add(M.chain,g);}
// ── saddle
{const nose=V3(0,.986,.165),tail=V3(0,.997,.405);const sc=CR([nose,V3(0,.982,.27),tail]);
 F.add(M.rubber,sweep(sc,{n:18,seg:20,caps:[true,true],prof:t=>({rx:pwl([0,.25,.5,.85,1],[.016,.022,.034,.068,.05],t),ry:pwl([0,.2,.85,1],[.014,.02,.024,.02],t),p:2.8,oy:-.004*Math.sin(t*Math.PI)})}));
 F.add(M.accent,sweep(sc,{n:12,seg:8,arc:[.42,.58],prof:t=>({rx:pwl([0,.25,.5,.85,1],[.016,.022,.034,.068,.05],t)*1.01,ry:pwl([0,.2,.85,1],[.014,.02,.024,.02],t)*1.02,p:2.8,oy:-.004*Math.sin(t*Math.PI)})}));
 for(const s of[-1,1])rod(F,M.alloy,V3(s*.018,.962,.205),V3(s*.028,.968,.375),.0035,.0035,6);
 rod(F,M.black,stAt(.95),stAt(.95).add(V3(0,.018,.008)),.016,.012,12);}
// bind pose: each bone on its pivot; the chain-run bones aligned with their runs (they stretch along local z)
FB.swing.position.copy(MP);FB.stays.position.copy(RA);FB.rocker.position.copy(PIV);FB.shock.position.copy(SL);FB.shockBody.position.copy(SL);
for(const[b,A,B]of[[FB.chainTop,CHN.At,CHN.Bt],[FB.chainBot,CHN.Ab,CHN.Bb]]){b.position.copy(A);b.quaternion.setFromUnitVectors(Z,B.clone().sub(A).normalize());}
F.build(bikeBody,{skel:skeletonOf(Object.values(FB))});

// ═════════════════════════════════════════════════════════════ wheels
function tyreGeo(){
 const nA=isMobile?84:110,nP=18,T0=2.3,ax=.0335,rc=.3445,ar=.0365;
 const pos=[],uv=[],idx=[];
 for(let i=0;i<=nA;i++){const ph=i/nA*TAU,c=Math.cos(ph),s=Math.sin(ph);
  for(let k=0;k<=nP;k++){const t=-T0+2*T0*k/nP;let r=rc+ar*Math.cos(t),x=ax*Math.sin(t);if(k===0||k===nP){r=.316;x=Math.sign(x)*.0245;}
   pos.push(x,r*c,r*s);uv.push(i/nA*2,k/nP);}}
 const W=nP+1;for(let i=0;i<nA;i++)for(let k=0;k<nP;k++){const a=i*W+k,b=a+W;idx.push(a,b,a+1,b,b+1,a+1);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();
 // stitch the seam normals
 const n=g.attributes.normal;for(let k=0;k<=nP;k++){const a=k,b=nA*W+k;const vx=n.getX(a)+n.getX(b),vy=n.getY(a)+n.getY(b),vz=n.getZ(a)+n.getZ(b),l=Math.hypot(vx,vy,vz);n.setXYZ(a,vx/l,vy/l,vz/l);n.setXYZ(b,vx/l,vy/l,vz/l);}
 // knobs: tapered blocks oriented to the carcass surface
 const knob=new THREE.BoxGeometry(1,1,1);knob.translate(0,.5,0);{const p=knob.attributes.position;for(let i=0;i<p.count;i++)if(p.getY(i)>.5){p.setX(i,p.getX(i)*.78);p.setZ(i,p.getZ(i)*.78);}}
 const parts=[g],S=V3(),dP=V3(),dT=V3(),Nn=V3(),Tt=V3(),m=new THREE.Matrix4();
 const rows=isMobile?56:68;
 const put=(ph,t,wAcross,wAlong,h,rot=0)=>{const c=Math.cos(ph),s=Math.sin(ph),r=rc+ar*Math.cos(t),x=ax*Math.sin(t);
  S.set(x,r*c,r*s);dP.set(0,-s,c);dT.set(ax*Math.cos(t),-ar*Math.sin(t)*c,-ar*Math.sin(t)*s).normalize();Nn.crossVectors(dP,dT).normalize();
  Tt.crossVectors(Nn,dP);const k=knob.clone();k.rotateY(rot);m.makeBasis(Tt,Nn,dP).setPosition(S.addScaledVector(Nn,-.0015));
  k.scale(1,1,1);const sc=new THREE.Matrix4().makeScale(wAcross,h,wAlong);k.applyMatrix4(sc);k.applyMatrix4(m);uvPt(k,[.25,.5]);parts.push(prep(k));};
 for(let i=0;i<rows;i++){const ph=i/rows*TAU;
  if(i%2===0){for(const sg of[-1,1]){put(ph,sg*.2,.013,.015,.0058);put(ph+.012,sg*.66,.012,.013,.0058,sg*.2);put(ph,sg*1.08,.016,.02,.0064);}}
  else{put(ph,0,.024,.012,.0058);for(const sg of[-1,1]){put(ph,sg*.45,.011,.012,.0056);put(ph+.01,sg*1.18,.013,.016,.006);}}}
 return mergeGeometries(parts.map(prep));}
const TYRE=tyreGeo();
// motion-blur disc: fades in over the spokes as the wheel spins up (spokes alias badly at speed)
const BLUR_M=new THREE.MeshStandardMaterial({color:0x101012,roughness:.5,metalness:.6,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide});
const BLUR_G=(()=>{const g=new THREE.RingGeometry(.036,.296,48,1);g.rotateY(Math.PI/2);const g2=g.clone().translate(.022,0,0);g.translate(-.022,0,0);return mergeGeometries([g,g2]);})();
function makeWheel(front){
 const outer=new THREE.Group(),spin=new THREE.Group();outer.add(spin);const K=new Kit();
 K.add(M.tyre,TYRE.clone());
 K.add(M.black,sweep(t=>V3(0,Math.cos(t*TAU)*.3035,Math.sin(t*TAU)*.3035),{n:72,seg:12,ref:X,closed:true,prof:()=>({rx:.0175,ry:.0128,p:4})}));
 const hw=front?.05:.054;
 K.add(M.black,latheX([[.009,-.079],[.017,-.077],[.018,-.064],[.031,-hw-.004],[.032,-hw+.002],[.019,-hw+.006],[.016,-.02],[.019,0],[.016,.02],[.019,hw-.006],[.032,hw-.002],[.031,hw+.004],[.018,.064],[.017,.077],[.009,.079]],22));
 for(let i=0;i<32;i++){const s=i%2?1:-1,ar=i/32*TAU,ah=ar+((i>>1)%2?1:-1)*1.05;
  rod(K,M.black,V3(s*hw,Math.cos(ah)*.029,Math.sin(ah)*.029),V3(s*.005,Math.cos(ar)*.298,Math.sin(ar)*.298),.0011,.0011,4);}
 const rt=new THREE.CircleGeometry(.1,48);rt.rotateY(Math.PI/2);rt.translate(front?-.054:-.062,0,0);K.add(M.rotor,rt);
 for(let i=0;i<6;i++){const a=i/6*TAU;xcyl(K,M.black,V3(front?-.057:-.065,Math.cos(a)*.034,Math.sin(a)*.034),.0042,.008,6);}
 if(!front){const tt=[24,21,19,17,15,13,11];tt.forEach((n,i)=>{const r=n*.0127/TAU+.002;xcyl(K,M.alloy,V3(.031+i*.0042,0,0),r,.0019,28);});}
 K.build(spin);
 const blur=new THREE.Mesh(BLUR_G,BLUR_M);blur.renderOrder=2;blur.visible=false;outer.add(blur);
 return{outer,spin,blur};}
const RW=makeWheel(false),FW=makeWheel(true);RW.outer.position.copy(RA);bikeBody.add(RW.outer);

// ═════════════════════════════════════════════════════════════ fork + cockpit (steers about HD through HTB)
const fork=new THREE.Group();fork.position.copy(HTB);bikeBody.add(fork);
// two bones under the steering group: 0 = upper assembly (crowns, stanchions, cockpit), 1 = lowers, which slide up
// the legs by the fork stroke (front wheel, axle, arch, caliper ride on them)
const FKB=['forkUpper','forkLowers'].map((n,i)=>{const b=new THREE.Bone();b.name=n;b.userData.i=i;fork.add(b);return b;});
const FK=new Kit(0);
// A big-hit DH fork, drawn ~15% over a real 40 mm fork so it reads at chase-cam distance (47 mm stanchions, legs
// 180 mm apart). Distances from the axle along the legs:
// LCB = underside of the lower crown's bridge (it sits right under the head-tube cup; the tyre clears it by 6 mm at
// full travel), the clamp bosses hang 26 mm lower; LW = top of the lowers (seal), 230 mm of stanchion showing.
const LX=.09,RS=.0235,LCB=.5316+FR,TUC=.7015+FR,LW=.26+FR;
for(const s of[-1,1]){const sx=s*LX;
 FK.bone=1;
 FK.add(M.paint,sweep(line(legPt(-.03,sx),legPt(LW,sx)),{n:12,seg:22,uv:UVF.low,caps:[true,false],prof:t=>{const r=mix(.032,.035,t)+.003*sstep(.86,1,t);return{rx:r,ry:r*1.05,capBulge:.01};}}));
 rod(FK,M.rubber,legPt(LW-.004,sx),legPt(LW+.016,sx),.037,.0305,22);                                  // seal / wiper
 xcyl(FK,M.black,legPt(0,sx),.028,.05,18);                                                           // axle boss
 // guard on the front of each lower leg
 FK.add(M.rubber,sweep(line(legPt(.06,sx),legPt(.25,sx)),{n:4,seg:12,ref:X,caps:[true,true],prof:t=>({rx:.024-.004*t,ry:.004,p:4,ox:s*.007,oy:.0385})}));
 FK.bone=0;
 rod(FK,M.gold,legPt(LW-.05,sx),legPt(TUC+.035,sx),RS,RS,24);
 rod(FK,M.black,legPt(TUC+.035,sx),legPt(TUC+.048,sx),RS+.001,RS+.001,22);
 rod(FK,s>0?M.accent:M.gold,legPt(TUC+.048,sx),legPt(TUC+.06,sx),.01,.01,12);
}
FK.bone=1;
xcyl(FK,M.alloy,FA,.0115,.238,14);rod(FK,M.black,FA.clone().setX(.119),FA.clone().add(V3(.123,0,.06)),.0065,.005,8);
for(const f of[-.013,.013])xcyl(FK,M.alloy,legPt(-.012,LX+.025).addScaledVector(FWD,f),.0055,.008,8);   // axle pinch bolts
// arch: deep-section, bulging forward, clear of the tyre, and far enough forward to pass in front of the lower crown
FK.add(M.paint,sweep(CR([legPt(.2,-LX).addScaledVector(FWD,.026),legPt(.31,-.068).addScaledVector(FWD,.056),legPt(.42,0).addScaledVector(FWD,.084),legPt(.31,.068).addScaledVector(FWD,.056),legPt(.2,LX).addScaledVector(FWD,.026)]),{n:28,seg:14,ref:null,prof:t=>({rx:.016,ry:.026,p:2.6})}),null,PT.gloss);
FK.bone=0;
// crowns: a bridge (extruded outline in the plane normal to the steering axis) and a tall clamp boss round each
// stanchion with two pinch bolts across its front slot
for(const[b0,th,bl,bh]of[[LCB,.03,.026,0],[TUC-.013,.026,.009,.007]]){
 const sh=hullCircles([[-LX,0,.044],[LX,0,.044],[0,-.05,.036],[-.048,.012,.036],[.048,.012,.036]],16);
 const g=new THREE.ExtrudeGeometry(shapeOf(sh),{depth:th-.006,bevelEnabled:true,bevelThickness:.003,bevelSize:.003,bevelSegments:2,curveSegments:8});
 g.applyMatrix4(basisAt(legPt(b0+.003,0),X,FWD,HD));FK.add(M.black,g);
 for(const s of[-1,1]){const sx=s*LX,lo=b0-bl,hi=b0+th+bh;
  rod(FK,M.black,legPt(lo,sx),legPt(hi,sx),RS+.015,RS+.015,26);
  for(const f of[.3,.72])xcyl(FK,M.alloy,legPt(mix(lo,hi,f),sx).addScaledVector(FWD,RS+.017),.0068,.036,8);}}
rod(FK,M.black,axisPt(.13),axisPt(.165),.018,.018,16);
// direct-mount stem + bar
const BC=legPt(.745+FR,0).addScaledVector(FWD,.006);
for(const s of[-1,1])FK.add(M.black,sweep(CR([legPt(TUC+.012,s*.026).addScaledVector(FWD,-.048),legPt(TUC+.022,s*.026).addScaledVector(FWD,-.01),BC.clone().setX(s*.026)]),{n:8,seg:12,ref:X,caps:[true,true],prof:()=>({rx:.0075,ry:.016,p:4})}));
FK.add(M.black,sweep(line(BC.clone().setX(-.03),BC.clone().setX(.03)),{n:2,seg:20,ref:Y,prof:()=>({rx:.0215})}));
FK.add(M.alloy,sweep(line(BC.clone().add(V3(-.024,0,-.004)),BC.clone().add(V3(.024,0,-.004))),{n:2,seg:20,ref:Y,arc:[.3,.7],prof:()=>({rx:.0222})}));
const BARP=[[-.40,.031,.044],[-.27,.027,.024],[-.15,.022,.007],[-.10,.012,.001],[-.05,0,0],[0,0,0],[.05,0,0],[.10,.012,.001],[.15,.022,.007],[.27,.027,.024],[.40,.031,.044]];
const barC=CR(BARP.map(p=>BC.clone().add(V3(p[0],p[1],p[2]))));
const barAt=x=>barC.getPointAt(cl((x+.4)/.8,0,1)),barDir=x=>barC.getTangentAt(cl((x+.4)/.8,0,1)).normalize();
FK.add(M.black,sweep(t=>barC.getPointAt(t),{n:56,seg:14,ref:Y,caps:[true,true],prof:t=>{const ax=Math.abs(t*.8-.4);return{rx:mix(.0159,.0111,sstep(.06,.11,ax))};}}));
// grips with lock-on collars, brake levers, shifter, plate, hoses
const GRIP=[];
for(const s of[-1,1]){const g0=s*.272,g1=s*.398;
 FK.add(M.rubber,sweep(t=>barAt(mix(g0,g1,t)),{n:34,seg:14,ref:Y,caps:[false,true],prof:t=>({rx:.0158+.0011*Math.max(0,Math.sin(t*TAU*9))+.0012*sstep(.85,1,t)})}));
 for(const xx of[s*.267,s*.4])FK.add(M.black,sweep(t=>barAt(xx+s*mix(-.004,.004,t)),{n:1,seg:16,ref:Y,prof:()=>({rx:.0178})}));
 FK.add(M.accent,sweep(t=>barAt(s*.267+s*mix(-.0015,.0015,t)),{n:1,seg:16,ref:Y,prof:()=>({rx:.0181})}));
 GRIP.push({x:s*.335,s});
 // lever: clamp, master cylinder, reservoir, blade
 const cp=barAt(s*.222),d=barDir(s*.222);
 FK.add(M.black,sweep(t=>barAt(s*.222+mix(-.007,.007,t)),{n:1,seg:16,ref:Y,prof:()=>({rx:.0185})}));
 const fw=V3(0,0,-1),up=Y;
 const mc0=cp.clone().addScaledVector(fw,.02).addScaledVector(up,.008).addScaledVector(d,-s*.02),mc1=mc0.clone().addScaledVector(d,s*.07);
 rod(FK,M.black,mc0,mc1,.0105,.0095,14);
 rod(FK,M.black,mc0.clone().addScaledVector(up,.017).addScaledVector(d,s*.008),mc0.clone().addScaledVector(up,.017).addScaledVector(d,s*.05),.0085,.0085,6);
 const piv=mc1.clone().addScaledVector(fw,.006).addScaledVector(up,-.003);
 FK.add(M.black,sweep(CR([piv,piv.clone().addScaledVector(d,s*.035).addScaledVector(fw,.008).addScaledVector(up,-.008),piv.clone().addScaledVector(d,s*.085).addScaledVector(fw,.006).addScaledVector(up,-.014),piv.clone().addScaledVector(d,s*.098).addScaledVector(fw,-.002).addScaledVector(up,-.016)]),{n:12,seg:8,ref:null,caps:[true,true],prof:t=>({rx:.0032,ry:mix(.008,.0055,t)})}));
 if(s>0){const sp=barAt(.185);rod(FK,M.black,sp.clone().add(V3(0,-.02,-.004)),sp.clone().add(V3(.02,-.024,-.004)),.009,.009,10);
  rod(FK,M.accent,sp.clone().add(V3(.012,-.03,-.012)),sp.clone().add(V3(.035,-.038,-.02)),.004,.003,6);}
}
for(const s of[-1,1])FK.add(M.rubber,sweep(t=>barAt(s*(.4+t*.008)),{n:1,seg:14,ref:Y,caps:[false,true],prof:()=>({rx:.0125})}));
{const w=.172,h=.12,g=new THREE.PlaneGeometry(w,h,10,1);const p=g.attributes.position;for(let i=0;i<p.count;i++){const x=p.getX(i);p.setZ(i,-8*x*x*.12);}
 g.computeVertexNormals();g.rotateY(Math.PI);g.rotateX(-.2);uvRect(g,UVF.plate);const c=BC.clone().add(V3(0,.012,-.074));g.translate(c.x,c.y,c.z);FK.add(M.paint,g);
 const gb=new THREE.PlaneGeometry(w,h,10,1);const pb=gb.attributes.position;for(let i=0;i<pb.count;i++){const x=pb.getX(i);pb.setZ(i,-8*x*x*.12+.001);}
 gb.computeVertexNormals();gb.rotateX(-.2);gb.translate(c.x,c.y,c.z);FK.add(M.paint,gb,null,PT.paper);
 for(const s of[-1,1])rod(FK,M.black,c.clone().add(V3(s*.06,-.04,.01)),barAt(s*.06).add(V3(0,0,-.005)),.003,.003,5);}
// front brake hose: a loop in front of the crowns takes up the stroke (blended from the upper assembly to the lowers)
hose(FK,[barAt(-.2).add(V3(0,.008,-.03)),barAt(-.16).add(V3(-.01,-.03,-.11)),legPt(TUC-.04,-.134).addScaledVector(FWD,.048),legPt(LCB-.045,-.142).addScaledVector(FWD,.062),legPt(LW-.02,-.137).addScaledVector(FWD,.042),legPt(.2,-.13).addScaledVector(FWD,-.022),legPt(.1,-.122).addScaledVector(FWD,-.042)],.0027,M.rubber,
 t=>along(t,[[3/6,5/6]],[0,1]));
hose(FK,[barAt(.2).add(V3(0,.008,-.03)),barAt(.15).add(V3(.02,-.06,-.12)),axisPt(.05).add(V3(.04,-.02,-.07)),axisPt(.06).add(V3(.03,0,.02))]);
hose(FK,[barAt(.185).add(V3(.01,-.02,-.01)),barAt(.13).add(V3(.03,-.08,-.1)),axisPt(.04).add(V3(.045,-.02,-.05)),axisPt(.06).add(V3(.03,0,.02))],.0025,M.black);
FK.bone=1;caliper(FK,FA,null,-1.25,-.054,legPt(.05,-.085).addScaledVector(FWD,-.02));
FW.outer.position.copy(FA).sub(HTB);fork.add(FW.outer);
FK.build(fork,{off:HTB,skel:skeletonOf(FKB)});
function frontSuspension(sF){SUSP.sF=sF;FKB[1].position.copy(HD).multiplyScalar(sF);FW.outer.position.copy(FA).sub(HTB).addScaledVector(HD,sF);}

// ═════════════════════════════════════════════════════════════ cranks & pedals
const crank=new THREE.Group();crank.position.copy(BB);bikeBody.add(crank);
const CK=new Kit(),PL=165e-3;
xcyl(CK,M.black,V3(),.0125,.17,14);
for(const s of[-1,1]){CK.add(M.black,plateYZ(hullCircles([[0,0,.021],[s*PL,0,.0135]],16),s*.072,.017,.004));
 xcyl(CK,M.alloy,V3(s*.081,0,s*PL),.0075,.006,10);}
{const N=32,pts=[];for(let k=0;k<N;k++){const a=k/N*TAU,d=TAU/N;for(const[f,r]of[[0,.0612],[.28,.0655],[.5,.0688],[.72,.0655]])pts.push([Math.cos(a+f*d)*r,Math.sin(a+f*d)*r]);}
 const holes=[];for(let k=0;k<4;k++){const a=k/4*TAU+.4;holes.push(circlePts(Math.cos(a)*.045,Math.sin(a)*.045,.0085,12));}
 CK.add(M.black,plateYZ(pts,CHX,.0032,0,holes));
 CK.add(M.black,plateYZ(circlePts(0,0,.03,24),CHX+.006,.006,.0015));}
CK.build(crank);
const pedals=[];
for(const s of[-1,1]){const pg=new THREE.Group();pg.position.set(s*.138,0,s*PL);crank.add(pg);const PK=new Kit();
 const o=[[-.05,-.048],[.05,-.048],[.052,.0],[.05,.048],[-.05,.048],[-.052,0]];const sh=hullCircles(o.map(p=>[p[0],p[1],.006]),6);
 const g=new THREE.ExtrudeGeometry(shapeOf(sh,[[[-.03,-.03],[.03,-.03],[.03,.03],[-.03,.03]].reverse()]),{depth:.011,bevelEnabled:true,bevelThickness:.002,bevelSize:.002,bevelSegments:1});
 g.applyMatrix4(new THREE.Matrix4().makeBasis(X,V3(0,0,-1),Y).setPosition(0,-.0075,0));PK.add(M.black,g);
 xcyl(PK,M.black,V3(0,0,0),.008,.1,10);
 for(const[px,pz]of[[-.044,-.042],[0,-.045],[.044,-.042],[-.044,.042],[0,.045],[.044,.042],[-.047,0],[.047,0]])for(const sy of[-1,1])rod(PK,M.alloy,V3(px,sy*.0075,pz),V3(px,sy*.0125,pz),.0016,.0016,4);
 PK.build(pg);pedals.push(pg);}

// ═════════════════════════════════════════════════════════════ the rider (skinned)
const rider=new THREE.Group();rider.name='rider';bikeBody.add(rider);
const BN=['pelvis','chest','head','thighL','shinL','footL','thighR','shinR','footR','upL','foreL','handL','upR','foreR','handR'];
const bones={};const boneList=BN.map((n,i)=>{const b=new THREE.Bone();b.name=n;b.userData.i=i;bones[n]=b;rider.add(b);return b;});
const BI=n=>bones[n].userData.i;
const LEN={thigh:.45,shin:.44,up:.29,fore:.27,spine:.5,hipW:.088,shW:.18};
// joint positions (bike space) written by solve()
const J={hipC:V3(),shC:V3(),nb:V3(),dS:V3(),lat:V3(),front:V3(),back:V3(),pelvY:V3(),headUp:V3(),hip:[V3(),V3()],knee:[V3(),V3()],ank:[V3(),V3()],sh:[V3(),V3()],elb:[V3(),V3()],wr:[V3(),V3()],legN:[V3(),V3()],armN:[V3(),V3()]};
const _a=V3(),_b=V3(),_c=V3(),_d=V3(),_e=V3(),_mx=new THREE.Matrix4(),_q=new THREE.Quaternion();
function ik(A,C,l1,l2,pole,out){_b.subVectors(C,A);const D=Math.min(_b.length(),l1+l2-.002);_b.normalize();const x=(l1*l1-l2*l2+D*D)/(2*D),h=Math.sqrt(Math.max(0,l1*l1-x*x));
 _c.subVectors(pole,A);_c.addScaledVector(_b,-_c.dot(_b)).normalize();return out.copy(A).addScaledVector(_b,x).addScaledVector(_c,h);}
function setBone(b,o,xh,y){const Yv=_a.copy(y).normalize(),Xv=_b.copy(xh).addScaledVector(Yv,-xh.dot(Yv)).normalize(),Zv=_c.crossVectors(Xv,Yv);
 _mx.makeBasis(Xv,Yv,Zv);b.quaternion.setFromRotationMatrix(_mx);b.position.copy(o);}
// grip frames in bike space for a steering angle
const GF=[0,1].map(()=>({o:V3(),A:V3(),U:V3(),K:V3()}));
const qSteer=new THREE.Quaternion();
function gripFrames(steer){qSteer.setFromAxisAngle(HD,steer);
 GF.forEach((g,i)=>{const x=GRIP[i].x;g.o.copy(barAt(x)).sub(HTB).applyQuaternion(qSteer).add(HTB);g.A.copy(barDir(x)).applyQuaternion(qSteer);
  g.U.copy(Y).applyQuaternion(qSteer);g.U.addScaledVector(g.A,-g.U.dot(g.A)).normalize();g.K.crossVectors(g.A,g.U);});}
const pedalPos=(i,c,out)=>{const s=i?1:-1,a=i?c:c+Math.PI;return out.set(s*.138,BB.y+Math.sin(a)*PL,BB.z+Math.cos(a)*PL);};
const FOOT=[{o:V3(),f:V3(),u:V3(),k:V3()},{o:V3(),f:V3(),u:V3(),k:V3()}];
const BUTT=[[-.08,-.215],[-.02,-.186],[.03,-.16],[.06,-.141],[.09,-.128],[.12,-.106],[.14,-.091],[.155,-.064],[.16,-.04]];
// P: crouch 0..1, ext 0..1 (air extension), ra (rear axle, for tyre clearance), brake, lean (rider counter-lean, rad), shift (lateral hip shift), crank (visual), headPitch, headRoll, kneeIn[2]
function solve(P){
 const c=P.crouch,e=P.ext;
 const rz=new THREE.Matrix4().makeRotationZ(-P.lean);
 // fore = weight forward (+, over the bars) or back (−, hips behind the saddle)
 const fo=P.fore||0;
 J.hipC.set(P.shift,1.13-.19*c+.07*e-.03*P.brake-.035*Math.abs(fo),.25+.04*c+.06*P.brake-.03*e-.085*fo).applyMatrix4(rz);
 // with the hips low and back and the rear end deep in its travel the tyre would reach the seat of the shorts: lift the
 // hips just enough to keep the backside (BUTT: its profile relative to the hip centre) 13 mm clear of the tread
 if(P.ra){let lift=0;for(const[dz,dy]of BUTT){const z=J.hipC.z+dz-P.ra.z,q=.4*.4-z*z;if(q>0)lift=Math.max(lift,P.ra.y+Math.sqrt(q)-J.hipC.y-dy);}J.hipC.y+=lift;}
 const th=.66+.2*c-.14*e+.06*P.brake+.12*fo;J.dS.set(0,Math.cos(th),-Math.sin(th)).applyMatrix4(rz);
 J.lat.set(1,0,0).applyMatrix4(rz);J.back.crossVectors(J.lat,J.dS).normalize();J.front.copy(J.back).negate();
 J.pelvY.copy(J.dS).multiplyScalar(.65).addScaledVector(_d.set(0,1,0).applyMatrix4(rz),.35).normalize();
 J.shC.copy(J.hipC).addScaledVector(J.dS,LEN.spine);
 J.nb.copy(J.shC).addScaledVector(J.dS,.035).addScaledVector(J.back,.045);
 const hp=P.headPitch;J.headUp.set(0,Math.cos(hp),-Math.sin(hp)).applyAxisAngle(Z,P.headRoll);
 setBone(bones.pelvis,J.hipC,J.lat,J.pelvY);
 setBone(bones.chest,_e.copy(J.hipC).addScaledVector(J.dS,.24),J.lat,J.dS);
 setBone(bones.head,J.nb,J.lat,J.headUp);
 gripFrames(P.steer);
 for(let i=0;i<2;i++){const s=i?1:-1,L=i?'R':'L';
  // legs
  J.hip[i].copy(J.hipC).addScaledVector(J.lat,s*LEN.hipW).addScaledVector(J.pelvY,-.06);
  const ft=FOOT[i];pedalPos(i,P.crank,ft.o);ft.o.y+=.0105;
  const ang=i?P.crank:P.crank+Math.PI;const fp=.2+.06*Math.cos(ang)+.06*c;  // heel drop, a little ankling through the stroke
  ft.f.set(0,Math.sin(fp),-Math.cos(fp));ft.u.set(0,Math.cos(fp),Math.sin(fp));ft.k.copy(ft.f).negate();
  ft.f.applyAxisAngle(ft.u,-s*.09);ft.k.copy(ft.f).negate();
  J.ank[i].copy(ft.o).addScaledVector(ft.u,.085).addScaledVector(ft.k,.115);
  const pole=_d.copy(J.hip[i]).add(_e.set(s*(.32+P.kneeOut[i]),-.1,-1));
  ik(J.hip[i],J.ank[i],LEN.thigh,LEN.shin,pole,J.knee[i]);
  J.legN[i].crossVectors(_e.subVectors(J.ank[i],J.hip[i]),_d.sub(J.hip[i])).normalize();
  setBone(bones['thigh'+L],J.hip[i],J.legN[i],_e.subVectors(J.knee[i],J.hip[i]));
  setBone(bones['shin'+L],J.knee[i],J.legN[i],_e.subVectors(J.ank[i],J.knee[i]));
  _mx.makeBasis(_a.crossVectors(ft.u,ft.k),ft.u,ft.k);bones['foot'+L].quaternion.setFromRotationMatrix(_mx);bones['foot'+L].position.copy(ft.o);
  // arms
  J.sh[i].copy(J.shC).addScaledVector(J.lat,s*LEN.shW).addScaledVector(J.dS,-.025).addScaledVector(J.front,.01);
  const g=GF[i];J.wr[i].copy(g.o).addScaledVector(g.U,.03).addScaledVector(g.K,.07).addScaledVector(g.A,-s*.006);
  const ap=_d.copy(J.sh[i]).add(_e.set(s*(.5+.3*c),-.55,.3));
  ik(J.sh[i],J.wr[i],LEN.up,LEN.fore,ap,J.elb[i]);
  J.armN[i].crossVectors(_e.subVectors(J.wr[i],J.sh[i]),_d.sub(J.sh[i])).normalize();
  setBone(bones['up'+L],J.sh[i],J.armN[i],_e.subVectors(J.elb[i],J.sh[i]));
  setBone(bones['fore'+L],J.elb[i],J.armN[i],_e.subVectors(J.wr[i],J.elb[i]));
  _mx.makeBasis(g.A,g.U,g.K);bones['hand'+L].quaternion.setFromRotationMatrix(_mx);bones['hand'+L].position.copy(g.o);
 }}

// ── skinned lofts
// rings: [{P,T,B,N, rx,ry,ox,oy,p, v, w:[[bone,w],[bone,w]], fold}] ; returns geometry with skin attributes
function skinLoft(rings,{seg=16,arc=[0,1],uv=[0,0,1,1],capEnd=false,capStart=false}){
 const pos=[],nor=[],uvs=[],si=[],sw=[],idx=[],q=V3();
 for(const r of rings){const ex=2/(r.p||2);
  for(let j=0;j<=seg;j++){const f=mix(arc[0],arc[1],j/seg),a=f*TAU,S=Math.sin(a),C=Math.cos(a);
   const ss=Math.sign(S)*Math.abs(S)**ex,cc=Math.sign(C)*Math.abs(C)**ex;const fold=1+(r.fold||0)*(Math.sin(a*5+r.v*31)*.6+Math.sin(a*3-r.v*17)*.4);
   q.copy(r.P).addScaledVector(r.B,r.rx*ss*fold+(r.ox||0)).addScaledVector(r.N,-r.ry*cc*fold+(r.oy||0));pos.push(q.x,q.y,q.z);
   q.set(0,0,0).addScaledVector(r.B,Math.sign(S)*Math.abs(S)**(2-ex)/r.rx).addScaledVector(r.N,-Math.sign(C)*Math.abs(C)**(2-ex)/r.ry).normalize();nor.push(q.x,q.y,q.z);
   uvs.push(mix(uv[0],uv[2],j/seg),mix(uv[1],uv[3],r.v));
   si.push(r.w[0][0],r.w[1]?r.w[1][0]:0,0,0);sw.push(r.w[0][1],r.w[1]?r.w[1][1]:0,0,0);}}
 const W=seg+1,flip=arc[1]<arc[0];
 for(let i=0;i<rings.length-1;i++)for(let j=0;j<seg;j++){const a=i*W+j,b=a+W;if(flip)idx.push(a,b,a+1,a+1,b,b+1);else idx.push(a,a+1,b,a+1,b+1,b);}
 const cap=(ri,dirSign)=>{const r=rings[ri],c0=pos.length/3;pos.push(r.P.x,r.P.y,r.P.z);q.copy(r.T).multiplyScalar(dirSign);nor.push(q.x,q.y,q.z);uvs.push(uvs[ri*W*2],uvs[ri*W*2+1]);
  si.push(r.w[0][0],r.w[1]?r.w[1][0]:0,0,0);sw.push(r.w[0][1],r.w[1]?r.w[1][1]:0,0,0);
  for(let j=0;j<seg;j++){const a=ri*W+j;if((dirSign>0)!==flip)idx.push(a,a+1,c0);else idx.push(a+1,a,c0);}};
 if(capEnd)cap(rings.length-1,1);if(capStart)cap(0,-1);
 return mkSkinGeo(pos,nor,uvs,si,sw,idx);}
function mkSkinGeo(pos,nor,uvs,si,sw,idx){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
 g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(si,4));g.setAttribute('skinWeight',new THREE.Float32BufferAttribute(sw,4));g.setIndex(idx);return g;}
// a rigid part bound 100% to one bone: geometry given in that bone's local frame
function rigid(g,bone,uv){prep(g);if(uv)uvPt(g,uv);g.applyMatrix4(bone.matrix);const n=g.attributes.position.count,si=new Uint16Array(n*4),sw=new Float32Array(n*4);
 for(let i=0;i<n;i++){si[i*4]=bone.userData.i;sw[i*4]=1;}g.setAttribute('skinIndex',new THREE.BufferAttribute(si,4));g.setAttribute('skinWeight',new THREE.BufferAttribute(sw,4));return g;}
// limb loft along A→K→C (bind pose) with a filleted joint
function limbLoft(A,K,C,n,l1,l2,ds,prof,b0,b1,bp,o){
 const d1=_a.subVectors(K,A).normalize().clone(),d2=_b.subVectors(C,K).normalize().clone(),fl=.045;
 const outward=d1.clone().sub(d2).normalize();
 const P=d=>{if(d<l1-fl)return A.clone().addScaledVector(d1,d);if(d>l1+fl)return K.clone().addScaledVector(d2,d-l1);
  const t=(d-(l1-fl))/(2*fl),p0=K.clone().addScaledVector(d1,-fl),p2=K.clone().addScaledVector(d2,fl);return p0.multiplyScalar((1-t)*(1-t)).addScaledVector(K,2*t*(1-t)).addScaledVector(p2,t*t);};
 const rings=[];
 for(const d of ds){const p=P(d),T=P(d+.003).sub(P(d-.003)).normalize(),B=n.clone().addScaledVector(T,-n.dot(T)).normalize(),N=V3().crossVectors(T,B);
  const sg=Math.sign(N.dot(outward))||1;const pr=prof(d);
  const wj=sstep(l1-.06,l1+.06,d),wp=bp!=null?1-sstep(-.07,.07,d):0;
  const w=wp>0?[[bp,wp],[b0,1-wp]]:[[b0,1-wj],[b1,wj]];
  rings.push({P:p,T,B,N,rx:pr.rx,ry:pr.ry,oy:-(pr.oy||0)*sg,p:pr.p,v:pr.v,fold:pr.fold,w});}
 return skinLoft(rings,o);}

function buildRider(){
 const neutral={crouch:.35,ext:0,brake:0,lean:0,shift:0,crank:0,headPitch:.1,headRoll:0,steer:0,kneeOut:[0,0]};
 solve(neutral);rider.updateMatrixWorld(true);
 const core=[],limbs=[];
 // ── torso: crotch → hips → chest → shoulders → neck
 {const crotch=J.hipC.clone().addScaledVector(J.pelvY,-.1),top=J.nb.clone().addScaledVector(J.headUp,.12);
  const sp=CR([crotch,J.hipC,J.hipC.clone().addScaledVector(J.dS,.25).addScaledVector(J.back,.02),J.shC,J.nb,top]);
  const len=sp.getLength();const D=[0,.03,.07,.11,.15,.2,.236,.237,.25,.3,.36,.42,.48,.53,.57,.6,.625,.645,.663,.677,.69,.7,.73,.77];
  const PR={d:[0,.04,.1,.17,.236,.237,.33,.42,.5,.56,.6,.635,.66,.675,.69,.7,.77],
   rx:[.11,.15,.172,.168,.158,.174,.168,.174,.188,.198,.192,.15,.1,.075,.06,.052,.05],
   ry:[.075,.1,.118,.112,.106,.124,.12,.127,.132,.125,.112,.095,.08,.068,.058,.052,.05],
   oy:[0,-.008,-.015,-.006,0,0,.008,.012,.012,.006,0,0,0,.005,.008,.008,.012]};
  const rings=[];
  for(const d of D){const t=cl(d/len,0,1),P=sp.getPointAt(t),T=sp.getTangentAt(t).normalize(),B=J.lat.clone().addScaledVector(T,-J.lat.dot(T)).normalize(),N=V3().crossVectors(T,B);
   const wc=sstep(.2,.36,d),wh=sstep(.63,.7,d);
   const w=wh>0?[[BI('chest'),1-wh],[BI('head'),wh]]:[[BI('pelvis'),1-wc],[BI('chest'),wc]];
   rings.push({P,T,B,N,rx:pwl(PR.d,PR.rx,d),ry:pwl(PR.d,PR.ry,d),oy:pwl(PR.d,PR.oy,d),p:d<.62?2.5:2.1,v:pwl([0,.236,.237,.53,.66,.77],[0,.255,.268,.66,.86,1],d),
    fold:d>.237&&d<.6?.022:d<.236&&d>.03?.015:0,w});}
  core.push(skinLoft(rings,{seg:28,arc:[.75,-.25],uv:UVR.torso,capStart:true,capEnd:true}));}
 // ── legs
 for(let i=0;i<2;i++){const L=i?'R':'L';
  const ds=[-.08,-.03,.03,.1,.18,.26,.33,.37,.371,.39,.42,.45,.49,.53,.57,.6,.625,.626,.66,.72,.78,.84,.9];
  const prof=d=>{let rx,ry,oy=0,fold=0;
   if(d<=.37){rx=mix(.094,.08,sstep(-.05,.37,d));ry=mix(.098,.083,sstep(-.05,.37,d));fold=.03;}
   else if(d<.626){const k=bump(.37,.626,d);rx=.062+.006*k;ry=.06+.012*k;oy=.006+.014*bump(.39,.6,d);}
   else{rx=mix(.047,.036,sstep(.63,.9,d));ry=mix(.052,.04,sstep(.63,.9,d));}
   const v=1-pwl([-.08,.37,.371,.626,.627,.9],[0,.4,.41,.7,.705,1],d);return{rx,ry,oy,v,p:2.1,fold};};
  limbs.push(limbLoft(J.hip[i],J.knee[i],J.ank[i],J.legN[i],LEN.thigh,LEN.shin,ds,prof,BI('thigh'+L),BI('shin'+L),BI('pelvis'),{seg:18,arc:[-.25,.75],uv:UVR.leg}));}
 // ── arms
 for(let i=0;i<2;i++){const L=i?'R':'L';
  const ds=[-.06,-.02,.03,.09,.15,.21,.25,.29,.33,.37,.42,.47,.51,.53,.545,.56,.575];
  const prof=d=>{const rx=pwl([-.06,0,.1,.2,.29,.36,.47,.53,.575],[.066,.064,.057,.052,.048,.047,.041,.037,.035],d),ry=pwl([-.06,0,.1,.2,.29,.36,.47,.53,.575],[.07,.066,.06,.054,.05,.049,.042,.036,.034],d);
   return{rx,ry,oy:.006*bump(.24,.34,d),v:1-pwl([-.06,.575],[0,1],d),p:2,fold:d<.5?.03:0};};
  limbs.push(limbLoft(J.sh[i],J.elb[i],J.wr[i],J.armN[i],LEN.up,LEN.fore,ds,prof,BI('up'+L),BI('fore'+L),BI('chest'),{seg:14,uv:UVR.arm,capStart:true}));}
 // ── gloves (hand-bone local frame: x = bar axis toward rider-right, y up, z back; grip centred on the x axis)
 for(let i=0;i<2;i++){const s=i?1:-1,hb=bones[i?'handR':'handL'],parts=[];
  const fing=(x0,a0,a1,r0,r1)=>sweep(t=>{const a=mix(a0,a1,t),rr=.0262;return V3(x0,Math.cos(a)*rr,-Math.sin(a)*rr);},{n:9,seg:8,ref:X,caps:[false,true],prof:t=>({rx:mix(r0,r1,t),ry:mix(r0,r1,t)*.9,capBulge:.004})});
  // three wrapped fingers
  [[-.012,.0088],[.009,.0086],[.029,.0078]].forEach(([x,r])=>{const g=fing(s*x,-.55,3.35,r,r*.86);uvPt(g,RP.glove);parts.push(g);});
  // index finger on the lever
  {const g=sweep(CR([V3(-s*.034,.022,-.004),V3(-s*.036,.017,-.032),V3(-s*.037,.003,-.047),V3(-s*.036,-.012,-.05)]),{n:10,seg:8,ref:null,caps:[false,true],prof:t=>({rx:mix(.0088,.0076,t),capBulge:.004})});uvPt(g,RP.glove);parts.push(g);}
  // thumb wraps under on the inboard side
  {const g=sweep(CR([V3(-s*.03,.008,.03),V3(-s*.044,-.006,.01),V3(-s*.047,-.02,-.008),V3(-s*.04,-.028,-.022)]),{n:10,seg:8,ref:null,caps:[false,true],prof:t=>({rx:mix(.0115,.0085,t),capBulge:.004})});uvPt(g,RP.glove);parts.push(g);}
  // back of the hand / palm block
  {const g=sweep(CR([V3(0,.035,.078),V3(0,.031,.04),V3(s*.002,.024,.004)]),{n:8,seg:16,ref:X,caps:[false,true],prof:t=>({rx:mix(.03,.043,t),ry:mix(.024,.016,t),p:2.6,capBulge:.006})});
   const a=g.attributes.uv;for(let k=0;k<a.count;k++)a.setXY(k,mix(.01,.11,a.getY(k)),mix(.27,.36,a.getX(k)));parts.push(g);}
  // cuff
  {const g=sweep(line(V3(0,.04,.06),V3(0,.046,.112)),{n:2,seg:16,ref:X,prof:t=>({rx:.039,ry:.034})});uvPt(g,RP.cuff);parts.push(g);}
  for(const g of parts)limbs.push(rigid(g,hb));}
 // ── shoes (foot-bone local frame: x right, y up from the pedal surface, z back; ball of the foot over the axle)
 for(let i=0;i<2;i++){const fb=bones[i?'footR':'footL'],parts=[];
  const sole=sweep(line(V3(0,.012,-.12),V3(0,.012,.16)),{n:12,seg:16,ref:X,caps:[true,true],prof:t=>({rx:pwl([0,.15,.45,.8,1],[.03,.05,.052,.043,.035],t),ry:.012,p:4,capBulge:.01})});uvPt(sole,RP.sole);parts.push(sole);
  const up=sweep(CR([V3(0,.03,-.115),V3(0,.045,-.06),V3(0,.07,.03),V3(0,.085,.1),V3(0,.09,.135)]),{n:14,seg:18,ref:X,caps:[true,true],prof:t=>({rx:pwl([0,.2,.5,.8,1],[.026,.044,.047,.04,.036],t),ry:pwl([0,.2,.5,.75,1],[.012,.024,.042,.052,.045],t),p:2.4,oy:-pwl([0,.5,1],[.0,.012,.02],t),capBulge:.008})});
  {const a=up.attributes.uv;for(let k=0;k<a.count;k++)a.setXY(k,mix(.255,.495,a.getX(k)),mix(.32,.495,a.getY(k)));}parts.push(up);
  const col=sweep(line(V3(0,.055,.1),V3(0,.135,.118)),{n:2,seg:16,ref:Y,prof:t=>({rx:.043,ry:mix(.05,.046,t)})});{const a=col.attributes.uv;for(let k=0;k<a.count;k++)a.setXY(k,mix(.26,.49,a.getY(k)),mix(.36,.48,a.getX(k)));}parts.push(col);
  const tab=sweep(line(V3(0,.06,.145),V3(0,.11,.15)),{n:1,seg:8,ref:X,prof:()=>({rx:.018,ry:.008,p:3})});uvPt(tab,RP.heel);parts.push(tab);
  for(const g of parts)limbs.push(rigid(g,fb));}
 // ── head (skin, visible only through the eye port) and neck brace
 {const h=new THREE.SphereGeometry(.093,18,14);h.scale(.92,1.08,1.05);h.translate(0,.13,-.012);core.push(rigid(h,bones.head,RP.skin));
  const chest=bones.chest,inv=chest.matrix.clone().invert();
  const c0=J.nb.clone().addScaledVector(J.dS,-.035).applyMatrix4(inv);
  const br=sweep(t=>{const a=t*TAU;return V3(Math.sin(a)*.118,0,Math.cos(a)*.105).add(V3(0,-Math.cos(a)*.018,0)).add(c0);},{n:40,seg:8,ref:Y,closed:true,prof:()=>({rx:.012,ry:.03,p:3})});
  // rotate brace so its plane is normal to the chest bone's Y (it's built in chest-local coordinates already)
  uvPt(br,RP.brace);
  core.push(rigid(br,chest));}
 const inv=boneList.map(b=>b.matrix.clone().invert());
 const skel=new THREE.Skeleton(boneList,inv);
 const mk=gs=>{const g=fixNormals(mergeGeometries(gs));g.computeBoundingSphere();const m=new THREE.SkinnedMesh(g,M.body);m.bind(skel,new THREE.Matrix4());m.castShadow=m.receiveShadow=true;m.frustumCulled=false;rider.add(m);STATS.tris+=g.index.count/3;STATS.calls++;return m;};
 return{core:mk(core),limbs:mk(limbs)};}
const RIDER=buildRider();

// ── helmet & goggles, children of the head bone (head-local: y up the head, z back, face toward −z)
const helmet=new THREE.Group();bones.head.add(helmet);
{const HC=V3(0,.152,.004),RX=.134,RY=.152,RZ=.166;
 const port=(az,el)=>{const u=az/.92,v=(el-.07)/.31;return Math.abs(u)**3.2+Math.abs(v)**3.2<1;};   // eye port, az/el in rad (az 0 = front)
 const bottom=az=>{const f=Math.cos(az*.5)**2;return mix(-.66,-1.13,Math.max(0,Math.cos(az))**1.6)*1+0*f;};
 const surf=(az,el,k=1)=>{let r=1;const chin=Math.max(0,Math.cos(az))**2.2*sstep(-.2,-.5,el);r+=.17*chin;
  const p=V3(Math.sin(az)*Math.cos(el)*RX*r,Math.sin(el)*RY*(1+.05*chin),-Math.cos(az)*Math.cos(el)*RZ*r).multiplyScalar(k).add(HC);if(el<-.2)p.y-=.03*chin*k;return p;};
 const NA=isMobile?44:60,NE=isMobile?26:34;const pos=[],uv=[],idx=[];
 for(let i=0;i<=NA;i++)for(let j=0;j<=NE;j++){const az=-Math.PI+i/NA*TAU,el=-1.15+j/NE*(Math.PI/2+1.15);const p=surf(az,Math.min(el,1.5707));pos.push(p.x,p.y,p.z);uv.push(((az+Math.PI)/TAU+.25)%1,mix(0,1,(el+Math.PI/2)/Math.PI));}
 const keep=(az,el)=>!port(az,el)&&el>bottom(az);
 for(let i=0;i<NA;i++)for(let j=0;j<NE;j++){const az=-Math.PI+(i+.5)/NA*TAU,el=-1.15+(j+.5)/NE*(Math.PI/2+1.15);if(!keep(az,el))continue;const a=i*(NE+1)+j,b=a+NE+1;idx.push(a,a+1,b,b,a+1,b+1);}
 // fix the u seam at the back so the texture doesn't smear: duplicate handled by i=0 / i=NA columns
 {const a=new Float32Array(uv);for(let i=0;i<=NA;i++)for(let j=0;j<=NE;j++){const k=(i*(NE+1)+j)*2;a[k]=i/NA;}  // u: 0 at az=-π (back), .5 front
  // remap so texture's front (u=.75) lands on az=0: u_tex = (i/NA + .25) % 1 without wrap → shift by using the texture's repeat
  for(let i=0;i<=NA;i++)for(let j=0;j<=NE;j++){const k=(i*(NE+1)+j)*2;a[k]=i/NA+.25;}
  uv.length=0;uv.push(...a);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();
 TX.helmet.wrapS=THREE.RepeatWrapping;
 const HK=new Kit();HK.add(M.helmet,g);
 // rubber trim round the eye port and the bottom edge
 const portEdge=t=>{const a=t*TAU,c=Math.cos(a),s=Math.sin(a);const u=Math.sign(c)*Math.abs(c)**(2/3.2),v=Math.sign(s)*Math.abs(s)**(2/3.2);return surf(u*.92,.07+v*.31,1.004);};
 HK.add(M.rubber,sweep(portEdge,{n:64,seg:6,ref:null,closed:true,prof:()=>({rx:.0058})}));
 HK.add(M.rubber,sweep(t=>{const az=-Math.PI+t*TAU;return surf(az,bottom(az)+.012,1.0);},{n:64,seg:6,ref:null,closed:true,prof:()=>({rx:.0075})}));
 // peak
 {const pk=[],pi=[],pu=[];const n=14;for(let i=0;i<=n;i++){const az=-.78+1.56*i/n;const b=surf(az,.42,1.0),o=V3(Math.sin(az),0,-Math.cos(az));
   const tip=b.clone().addScaledVector(o,.075).add(V3(0,.035,0));for(const p of[b,b.clone().lerp(tip,.5).add(V3(0,.006,0)),tip]){pk.push(p.x,p.y,p.z);pu.push(.75+az/TAU,.62);}}
  for(let i=0;i<n;i++)for(let k=0;k<2;k++){const a=i*3+k,b=a+3;pi.push(a,b,a+1,b,b+1,a+1);}
  const pg=new THREE.BufferGeometry();pg.setAttribute('position',new THREE.Float32BufferAttribute(pk,3));pg.setAttribute('uv',new THREE.Float32BufferAttribute(pu,2));pg.setIndex(pi);pg.computeVertexNormals();HK.add(M.helmet,pg);}
 // goggles: lens, frame, strap
 const lensS=(u,v)=>{const az=u*.98,el=.07+v*.36;return surf(az,el,1.045);};
 {const n=20,m=8,lp=[],li=[];for(let i=0;i<=n;i++)for(let j=0;j<=m;j++){const u=-1+2*i/n,v=-1+2*j/m;const p=lensS(u*.97,v*(.92-.1*Math.abs(u)**4));lp.push(p.x,p.y,p.z);}
  for(let i=0;i<n;i++)for(let j=0;j<m;j++){const a=i*(m+1)+j,b=a+m+1;li.push(a,a+1,b,b,a+1,b+1);}
  const lg=new THREE.BufferGeometry();lg.setAttribute('position',new THREE.Float32BufferAttribute(lp,3));lg.setIndex(li);lg.computeVertexNormals();HK.add(M.lens,lg);}
 HK.add(M.rubber,sweep(t=>{const a=t*TAU,c=Math.cos(a),s=Math.sin(a);return lensS(Math.sign(c)*Math.abs(c)**.55*.99,Math.sign(s)*Math.abs(s)**.55*(.95-.1*Math.abs(c)**4));},{n:56,seg:6,ref:null,closed:true,prof:()=>({rx:.0085,ry:.0085})}));
 {const sp=[],su=[],si=[];const n=40;for(let i=0;i<=n;i++){const az=.86+(TAU-1.72)*i/n;for(const[k,el]of[[0,.05],[1,.18]]){const p=surf(az,el,1.035);sp.push(p.x,p.y,p.z);su.push(mix(.5,1,i/n*3%1),k?.5:.375);}}
  for(let i=0;i<n;i++){const a=i*2;si.push(a,a+2,a+1,a+2,a+3,a+1);}
  const sg=new THREE.BufferGeometry();sg.setAttribute('position',new THREE.Float32BufferAttribute(sp,3));sg.setAttribute('uv',new THREE.Float32BufferAttribute(su,2));sg.setIndex(si);sg.computeVertexNormals();HK.add(M.body,sg);}
 HK.build(helmet);}
// eye: just in front of the eyes, inside the eye port
const eye=new THREE.Object3D();eye.position.set(0,.132,-.035);
// hint for the helmet camera: pitch (rad, relative to the bike) that frames bars, gloves, stem and front tyre at the bottom of a ~100° view
eye.userData.fpPitch=-.48;bones.head.add(eye);

// ═════════════════════════════════════════════════════════════ animation
const ST8={wspd:0,crouch:.35,crouchV:0,ext:0,lean:0,brake:0,air:false,lastCrank:null,crankOff:0,pedalling:0,headPitch:.3};
function wrapPI(a){a=(a+Math.PI)%TAU;if(a<0)a+=TAU;return a-Math.PI;}
// ── rear linkage: solve the four-bar for a rear-axle rise sR (m, relative to the frame) and pose the bones.
// Angles are directions in the bike's side plane, atan2(y, z); a bone turned by Δ there is a rotation of −Δ about X.
const ang=(a,b)=>Math.atan2(b.y-a.y,b.z-a.z);
const rotYZ=(p,c,a,out)=>{const z=p.z-c.z,y=p.y-c.y,C=Math.cos(a),S=Math.sin(a);return out.set(p.x,c.y+z*S+y*C,c.z+z*C-y*S);};
const LK={cs:Math.hypot(RA.y-MP.y,RA.z-MP.z),ss:Math.hypot(SSP.y-RA.y,SSP.z-RA.z),rk:Math.hypot(SSP.y-PIV.y,SSP.z-PIV.z),
 aCS:ang(MP,RA),aSS:ang(RA,SSP),aRK:ang(PIV,SSP),aSH:ang(SL,SU),side:Math.sign((PIV.z-RA.z)*(SSP.y-RA.y)-(PIV.y-RA.y)*(SSP.z-RA.z)),
 tLen:CHN.At.distanceTo(CHN.Bt),bLen:CHN.Ab.distanceTo(CHN.Bb)};
const SUSP={sR:0,sF:0,stroke:0,ra:RA.clone(),ssp:SSP.clone(),su:SU.clone()};STATS.susp=SUSP;   // last solved state (for tools)
const _rb=V3(),_rd=V3();
function rearSuspension(sR){
 const dCS=Math.asin(cl((RA.y+sR-MP.y)/LK.cs,-1,1))-LK.aCS;const ra=rotYZ(RA,MP,dCS,SUSP.ra);
 // seat-stay eye = circle(RA′, stay) ∩ circle(PIV, rocker arm), on the same side of RA′→PIV as at top-out
 const dz=PIV.z-ra.z,dy=PIV.y-ra.y,D=Math.hypot(dz,dy),k=(LK.ss*LK.ss-LK.rk*LK.rk+D*D)/(2*D),h=LK.side*Math.sqrt(Math.max(0,LK.ss*LK.ss-k*k)),ez=dz/D,ey=dy/D;
 const ssp=SUSP.ssp.set(0,ra.y+ey*k+ez*h,ra.z+ez*k-ey*h);
 const dRK=ang(PIV,ssp)-LK.aRK,dSS=ang(ra,ssp)-LK.aSS,su=rotYZ(SU,PIV,dRK,SUSP.su);
 const L=Math.hypot(su.y-SL.y,su.z-SL.z);SUSP.sR=sR;SUSP.stroke=SHK.L0-L;
 FB.swing.quaternion.setFromAxisAngle(X,-dCS);
 FB.stays.position.copy(ra);FB.stays.quaternion.setFromAxisAngle(X,-dSS);
 FB.rocker.quaternion.setFromAxisAngle(X,-dRK);
 // shock: turns about its lower eye to point at SU′; the body side slides down the shaft by the stroke
 FB.shock.quaternion.setFromAxisAngle(X,-(ang(SL,su)-LK.aSH));FB.shockBody.quaternion.copy(FB.shock.quaternion);
 _rd.subVectors(su,SL).normalize();FB.shockBody.position.copy(SL).addScaledVector(_rd,-SUSP.stroke);
 // chain runs: from the fixed chainring tangent to the far end carried by the swingarm
 for(const[b,A,B,L0]of[[FB.chainTop,CHN.At,CHN.Bt,LK.tLen],[FB.chainBot,CHN.Ab,CHN.Bb,LK.bLen]]){
  rotYZ(B,MP,dCS,_rb).sub(A);const l=_rb.length();b.quaternion.setFromUnitVectors(Z,_rb.divideScalar(l));b.scale.set(1,1,l/L0);}
 RW.outer.position.copy(ra);}
// o = {steer (rad, fork angle), wheel (rad), crank (rad), crouch (0..1), lean (rad, + = left), air (bool), brake (0..1), dt}
function updateBikePose(o){
 const dt=Math.min(o.dt||.016,.05),S=ST8;
 fork.quaternion.setFromAxisAngle(HD,o.steer);
 rearSuspension(cl(o.sR||0,0,TRAVEL));frontSuspension(cl(o.sF||0,0,TRAVEL));
 RW.spin.rotation.x=-o.wheel;FW.spin.rotation.x=-o.wheel;
 if(S.lastWheel!==undefined){const w=Math.abs(o.wheel-S.lastWheel)/dt;S.wspd+=(Math.min(w,80)-S.wspd)*(1-Math.exp(-4*dt));}S.lastWheel=o.wheel;
 const bo=cl((S.wspd-6)/22,0,1)*.5;BLUR_M.opacity=bo;RW.blur.visible=FW.blur.visible=bo>.02;
 WIND.uWind.value=cl(S.wspd*WR/14,0,1.4);WIND.uT.value+=dt;
 // cranks: follow the game's crank while pedalling; when coasting, settle to level pedals (lead foot left),
 // dropping the outside foot through turns
 const crk=o.crank||0;const moving=S.lastCrank!==null&&Math.abs(crk-S.lastCrank)>1e-5;S.lastCrank=crk;
 S.pedalling=moving?1:Math.max(0,S.pedalling-dt*2.5);
 if(S.pedalling<.5){const turn=cl(o.lean/.35,-1,1);const target=-turn*Math.PI/2*.9;const err=wrapPI(target-(crk+S.crankOff));S.crankOff+=err*(1-Math.exp(-4*dt));}
 const cv=crk+S.crankOff;
 crank.rotation.x=-cv;for(const p of pedals)p.rotation.x=cv;
 TX.chain.offset.x=cv*RING/.0254;
 // body dynamics: crouch is a damped spring (landings overshoot), extension in the air
 const tgt=cl(o.crouch,0,1);
 if(S.air&&!o.air)S.crouchV+=2.2;                 // landing: soak it up
 S.crouchV+=((tgt-S.crouch)*90-S.crouchV*13)*dt;S.crouch=cl(S.crouch+S.crouchV*dt,0,1.15);
 S.air=!!o.air;S.ext+=((o.air?1:0)-S.ext)*(1-Math.exp(-(o.air?3:8)*dt));
 S.lean+=(o.lean-S.lean)*(1-Math.exp(-7*dt));S.fore=(S.fore||0)+((o.fore||0)-(S.fore||0))*(1-Math.exp(-8*dt));S.brake+=((o.brake||0)-S.brake)*(1-Math.exp(-5*dt));
 const pitch=bike.rotation.x||0,roll=bike.rotation.z||0;
 const hpT=cl(.08+pitch*.8+.06*S.crouch,-.3,.9);S.headPitch+=(hpT-S.headPitch)*(1-Math.exp(-6*dt));
 const ln=S.lean;
 solve({ra:SUSP.ra,crouch:Math.min(1,S.crouch)*(1-.55*S.ext),ext:S.ext,brake:S.brake,fore:cl(S.fore,-1,1),lean:ln*.33,shift:-ln*.05,crank:cv,steer:o.steer,headPitch:S.headPitch,headRoll:-roll*.65+ln*.33,
  kneeOut:[Math.max(0,ln)*.6,Math.max(0,-ln)*.6]});
}
// Put the rider back on the bike after a crash (game.js detaches rider/bikeBody to tumble them).
function reattachRider(){if(rider.parent!==bikeBody)bikeBody.add(rider);rider.position.set(0,0,0);rider.quaternion.identity();rider.scale.set(1,1,1);bikeBody.position.set(0,0,0);bikeBody.quaternion.identity();
 ST8.crouchV=0;ST8.air=false;ST8.ext=0;}
// First-person: hide what would block the view from inside / just behind the head (head, helmet, torso, neck brace).
// Arms, gloves, cockpit, legs and the bike stay visible.
function setFirstPerson(on){helmet.visible=!on;RIDER.core.visible=!on;NEAR_CUT.value=on?.56:0;}
updateBikePose({steer:0,wheel:0,crank:0,crouch:.35,lean:0,air:false,brake:0,dt:.016});
const bikeStats=STATS;
export {bike,bikeBody,rider,eye,updateBikePose,reattachRider,setFirstPerson,bikeStats};
