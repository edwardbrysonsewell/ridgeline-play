import * as THREE from 'three';
import {deckAt,WOOD_FEEL,setMountain,MOUNTAINS,postsIn,COURSE,STRUCTS,clamp,lerp,smooth,damp,wrapA,$,store,fmt,heightAt,surfaceInto,rideFeel,clearAt,GATES,FINISH,START,TILE,I_MIN,I_MAX,J_MIN,J_MAX,X_MIN,X_MAX,Z_MIN,Z_MAX,
 forestAt,featureList,isMobile} from './core.js';
import {renderer,scene,camera,resize,dust,debris,updateWorld,renderWorld,setQuality,getQuality} from './world.js';
import * as TERRAIN from './terrain.js';
import * as STRUCT from './structures.js';
const {buildTerrainTile,disposeTerrainTile,terrainReady}=TERRAIN;
import * as CORE from './core.js';
const mtn=()=>CORE.MOUNTAIN;
import * as FLORA from './flora.js';
import {bike,bikeBody,rider,eye,updateBikePose,reattachRider,setFirstPerson} from './bike.js';
import {HAP} from './haptics.js';
import {SFX} from './audio.js';
const {populateTile,updateFlora}=FLORA;const floraReady=FLORA.floraReady||Promise.resolve();
const V3=(x,y,z)=>new THREE.Vector3(x,y,z);

// ───────────────────────── tile streaming: terrain LOD + flora around the camera
const LOD_D=[110,300,700];const lodFor=d=>d<LOD_D[0]?0:d<LOD_D[1]?1:d<LOD_D[2]?2:3;
const FLORA_D=isMobile?650:800;
const tiles=new Map();const tkey=(i,j)=>(i+500)*10000+(j+5000);
for(let i=I_MIN;i<=I_MAX;i++)for(let j=J_MIN;j<=J_MAX;j++)tiles.set(tkey(i,j),{i,j,cx:(i+.5)*TILE,cz:(j+.5)*TILE,lod:-1,obj:null,busy:false,flora:null,floraBusy:false,d:1e9});
const tileList=[...tiles.values()];
let busyCount=0;
let tileGen=0;
function applyTerrain(t,lod,obj){if(t.obj){scene.remove(t.obj);disposeTerrainTile(t.obj);}t.obj=obj;t.lod=lod;scene.add(obj);}
function requestTerrain(t,lod){t.busy=true;busyCount++;const gen=tileGen;
 const done=obj=>{t.busy=false;busyCount--;if(gen!==tileGen){disposeTerrainTile(obj);return;}applyTerrain(t,lod,obj);},fail=e=>{t.busy=false;busyCount--;console.error(e);};
 try{const r=buildTerrainTile(t.i,t.j,lod);if(r&&typeof r.then==='function')r.then(done,fail);else done(r);}catch(e){fail(e);}}
function requestFlora(t){t.floraBusy=true;const gen=tileGen;
 const done=f=>{if(gen!==tileGen){t.floraBusy=false;return;}t.flora=f;t.floraBusy=false;if(f&&f.group)scene.add(f.group);if(f&&f.lod)f.lod(t.d,camera);},fail=e=>{t.floraBusy=false;t.flora={col:[]};console.error(e);};
 try{const r=populateTile(t.i,t.j);if(r&&typeof r.then==='function')r.then(done,fail);else done(r);}catch(e){fail(e);}}
// budgetMs: time allowed for synchronous builds this call
function updateTiles(budgetMs){const cx=camera.position.x,cz=camera.position.z,t0=performance.now();const need=[],needF=[];
 for(const t of tileList){t.d=Math.max(0,Math.hypot(t.cx-cx,t.cz-cz)-TILE*.6);
  if(!t.busy&&t.lod!==lodFor(t.d))need.push(t);if(!t.flora&&!t.floraBusy&&t.d<FLORA_D)needF.push(t);
  if(t.flora&&t.flora.lod)t.flora.lod(t.d,camera);}
 need.sort((a,b)=>a.d-b.d);needF.sort((a,b)=>a.d-b.d);
 // nearest first; a tile that needs a finer LOD near the rider jumps the queue
 for(const t of need){if(performance.now()-t0>budgetMs||busyCount>6)break;requestTerrain(t,lodFor(t.d));}
 for(const t of needF){if(performance.now()-t0>budgetMs*1.5)break;requestFlora(t);}}
const tileAt=(x,z)=>tiles.get(tkey(Math.floor(x/TILE),Math.floor(z/TILE)));
// stilts under raised woodwork are solid: colliders with a top, so they only matter when you're underneath
let POSTS=new Map();
function buildPostColliders(){POSTS=new Map();for(const q of postsIn(X_MIN,Z_MIN,X_MAX,Z_MAX)){const k=tkey(Math.floor(q.x/TILE),Math.floor(q.z/TILE));let a=POSTS.get(k);if(!a)POSTS.set(k,a=[]);a.push({x:q.x,z:q.z,r:.16,kind:'post',top:q.y1-.25});}}
function nearColliders(x,z,cb){const i0=Math.floor(x/TILE),j0=Math.floor(z/TILE);for(let i=i0-1;i<=i0+1;i++)for(let j=j0-1;j<=j0+1;j++){const k=tkey(i,j),t=tiles.get(k);if(t&&t.flora&&t.flora.col)for(const o of t.flora.col)cb(o);const ps=POSTS.get(k);if(ps)for(const o of ps)cb(o);}}

// ───────────────────────── gates, start and finish
function bannerTex(text,sub,check){const c=document.createElement('canvas');c.width=1024;c.height=192;const x=c.getContext('2d');
 x.fillStyle='#f4efe4';x.fillRect(0,0,1024,192);
 if(check){for(let i=0;i<32;i++)for(let j=0;j<2;j++){if((i+j)%2){x.fillStyle='#0e110d';x.fillRect(i*32,j*32+128,32,32);}}}
 x.fillStyle='#ff5f1f';x.fillRect(0,0,1024,14);
 x.fillStyle='#0e110d';x.font='900 104px "Big Shoulders Display", Impact, sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(text,512,check?72:86);
 if(sub){x.font='700 26px Chivo, Arial, sans-serif';x.fillStyle='rgba(14,17,13,.7)';x.fillText(sub,512,158);}
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return t;}
const flags=[];const gateObjs=[];
const beaconMat=c=>new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:.22,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,fog:false});
function makeGate(x,z,heading,text,sub,check,width=7){const g=new THREE.Group();g.position.set(x,heightAt(x,z),z);g.rotation.y=heading;
 const postM=new THREE.MeshStandardMaterial({color:0x1d211b,roughness:.6,metalness:.4});const half=width/2+.3;
 for(const sx of[-half,half]){const y0=heightAt(x+Math.cos(heading)*sx,z-Math.sin(heading)*sx)-g.position.y;const p=new THREE.Mesh(new THREE.CylinderGeometry(.12,.14,5.2-y0,10),postM);p.position.set(sx,(5.2+y0)/2-.3,0);p.castShadow=true;g.add(p);}
 const tex=bannerTex(text,sub,check);const bm=new THREE.MeshStandardMaterial({map:tex,roughness:.75,side:THREE.DoubleSide});
 const b=new THREE.Mesh(new THREE.PlaneGeometry(width+.8,1.5),bm);b.position.set(0,4.3,0);b.castShadow=true;g.add(b);
 const b2=b.clone();b2.rotation.y=Math.PI;b2.position.z=-.02;g.add(b2);
 const fm=new THREE.MeshStandardMaterial({color:0xff5f1f,roughness:.7,side:THREE.DoubleSide});
 for(const sx of[-half-1.6,half+1.6]){const pole=new THREE.Mesh(new THREE.CylinderGeometry(.03,.03,3.6,6),postM);pole.position.set(sx,1.6,.6);g.add(pole);
  const f=new THREE.Mesh(new THREE.PlaneGeometry(.7,1.6,6,1),fm);f.position.set(sx+(sx>0?-.35:.35),2.5,.6);f.castShadow=true;g.add(f);flags.push(f);}
 // beacon: a tall soft light column so the next gate can be found from far away
 const beam=new THREE.Mesh(new THREE.CylinderGeometry(1.4,2.2,90,16,1,true),beaconMat(0xff7a2a));beam.position.y=45;beam.renderOrder=5;g.add(beam);g.userData.beam=beam;
 scene.add(g);gateObjs.push(g);return g;}
const headingTo=(ax,az,bx,bz)=>Math.atan2(-(bx-ax),-(bz-az));
let gateMeshes=[],finishGate=null,startGate=null;
function clearCourse(){for(const o of gateObjs){scene.remove(o);o.traverse(c=>{if(c.geometry)c.geometry.dispose();});}gateObjs.length=0;flags.length=0;gateMeshes=[];}
function buildCourse(){clearCourse();
 startGate=makeGate(START.x,START.z-6,0,mtn().name.toUpperCase(),'START · '+mtn().sub.split(' · ')[0].toUpperCase(),false,8);startGate.userData.beam.visible=false;
 GATES.forEach((g,k)=>{const p=k?GATES[k-1]:{x:START.x,z:START.z};gateMeshes.push(makeGate(g.x,g.z,headingTo(p.x,p.z,g.x,g.z),'GATE '+(k+1),(k+1)+' / '+GATES.length,false,g.r*2));});
 const lg=GATES[GATES.length-1];finishGate=makeGate(FINISH.x,FINISH.z,headingTo(lg.x,lg.z,FINISH.x,FINISH.z),'FINISH','',true,FINISH.r*1.6);}
function styleGates(){gateMeshes.forEach((g,k)=>{const race=mode==='race';g.visible=race;g.userData.beam.visible=race&&k===gateIdx;
  g.userData.beam.material.color.set(k===gateIdx?0xff7a2a:0xffffff);});
 finishGate.userData.beam.visible=mode==='race'?gateIdx>=GATES.length:true;}


// ───────────────────────── game state
const G=9.81,WB=1.3,TRAVEL=.22,SAG=.07,SAG_F=.044;   // 220 mm of travel each end; sag ~20 % fork, ~32 % shock (DH setup guides)
// a bump under the front wheel now and under the rear a wheelbase later (ring buffer of physics steps at 120 Hz)
function suspKick(f,r,v){P.sFV+=f;const n=Math.min(150,Math.round(WB/Math.max(v,2)*120));P.bq[(P.bi+n)%P.bq.length]+=r;}
const P={x:0,y:0,z:0,vx:0,vy:0,vz:0,th:0,ground:true,air:0,whip:0,whipMax:0,pitch:0,roll:0,lean:0,leanV:0,airPitch:0,airOff:0,airOffV:0,slideT:0,steerA:0,susp:0,suspV:0,sF:.044,sR:.07,bp:0,bpw:0,frontFree:false,airW:0,sFV:0,sRV:0,bq:new Float32Array(160),bi:0,crank:0,wheel:0,skid:0,brake:0,spd:0,rough:0,pedal:false,om:0,dist:0};
const SW=[0,1,0,0];
const input={steer:0,steerT:0,brake:0,btnBrake:0,lean:0,hop:false,hopHeld:false,hopT:0,hopCharge:0,brakeHeld:false,keyL:0,keyR:0};
const DEV={fullAssist:false,log:null};
let mode=['free','skinny'].includes(store.get('mode'))?store.get('mode'):'race';
// skinnies (balance course) state: furthest section reached, dabs, the section you came off, finish flag
const SK={sec:-1,dabs:0,offT:0,onSec:-1,done:false,bestKey:()=>'bestSk_'+mtn().id};
let stuckT=0,state='loading',runT=0,best=null,bestSplits=[],gateIdx=0,splits=[],crashT=0,crashes=0,topSpd=0,airTotal=0,style=0,timeScale=1,shake=0,assist=true,cdT=0;
const camS={pos:new THREE.Vector3(),look:new THREE.Vector3(),dir:new THREE.Vector3(0,0,-1),fov:62,orbit:0};
const crashBodies=[];const crumbs=[];let crumbT=0;

// ground or deck under the rider: a deck counts if its top is no more than 0.5 m above the rider (so you can ride under one)
// On the ground you can only roll onto a deck where it's flush (its entry ramp); in the air you land on any deck
// you come down onto. A deck edge between 15 cm and head height in front of you is something you hit.
function surf(x,z){const g=heightAt(x,z),d=deckAt(x,z,P.y-(P.ground?.2:0));return d&&d.y>g?d.y:g;}
function deckSide(x,z){const d=deckAt(x,z,P.y+1.4);return d&&d.y>P.y+.3&&d.y>heightAt(x,z)+.1?d:null;}
function placeRider(x,z,th,y){P.x=x;P.z=z;P.y=y??heightAt(x,z);P.th=th;P.vx=P.vz=P.vy=0;P.ground=true;P.air=0;P.whip=0;P.pitch=0;P.roll=0;P.lean=0;P.leanV=0;P.susp=0;P.suspV=0;P.bp=NaN;P.bpw=0;P.frontFree=false;P.airW=0;P.sF=SAG_F;P.sR=SAG;P.sFV=P.sRV=0;P.bq.fill(0);
 reattachRider();crashBodies.length=0;setFirstPerson(view==='helmet');fp.yaw=P.th;}
function startRun(m){if(m)mode=m;if(typeof tilt!=='undefined')tilt.cal=true;store.set('mode',mode);
 if(mode==='skinny'&&CORE.BALANCE.start){const b=CORE.BALANCE.start;placeRider(b.x,b.z,b.th);SK.sec=-1;SK.dabs=0;SK.offT=0;SK.onSec=-1;SK.done=false;}else placeRider(START.x,START.z-1,0);runT=0;gateIdx=0;splits=[];crashes=0;topSpd=0;airTotal=0;style=0;P.dist=0;crumbs.length=0;
 state=mode==='race'?'countdown':'ride';cdT=3.2;styleGates();
 show(['title','results','pause','crashmsg'],false);show(['hud-time','hud-speed','minimap','pauseBtn','viewBtn','hop','brake','steerhint'],true);show(['nav'],mode==='race');
 $('hudLbl').textContent=mode==='race'?'Run time':mode==='skinny'?'Skinnies':'Style';const bs=mode==='skinny'?store.get(SK.bestKey()):best;$('tPB').textContent=(mode!=='free'&&bs)?'Best '+fmt(bs):'';
 $('toTop').hidden=mode==='race';}
function show(ids,on){for(const id of ids)$(id).hidden=!on;}
function pop(text,cls='',sub=''){const d=document.createElement('div');d.className='pop '+cls;d.innerHTML=text+(sub?'<small>'+sub+'</small>':'');$('pops').appendChild(d);setTimeout(()=>d.remove(),1600);
 while($('pops').children.length>3)$('pops').firstChild.remove();}
// one place for every discrete thing you feel (and, with the audio module, hear)
function fx(name,k=1,opt){if(SFX.event)SFX.event(name,k,opt);
 switch(name){
  case 'land':HAP.tap(clamp(k,.12,1),.3);break;                       // heavy and dull, scaled by the impact
  case 'bottom':HAP.seq([[0,1,.12],[.07,.6,.3]]);break;                // the fork slamming its stop
  case 'crash':HAP.seq([[0,1,.2],[.11,.75,.5],[.26,.45,.3],[.5,.25,.2]]);break;
  case 'hop':HAP.tap(.3+.35*k,.7);break;
  case 'log':HAP.tap(.7,.35);break;
  case 'gate':HAP.seq([[0,.45,.9],[.09,.45,.9]]);break;
  case 'finish':HAP.seq([[0,.5,.9],[.1,.5,.9],[.2,.85,.7]]);break;
  case 'miss':HAP.tap(.6,.1);break;
  case 'dab':HAP.tap(.6,.4);break;
  case 'count':HAP.tap(k?.8:.3,.85);break;
  case 'trick':HAP.seq([[0,.6,.8],[.1,.6,.8],[.2,.9,.6]]);SFX.chime();break;}}
// trunks, posts and boulders flashing past close by: a whoosh panned to their side (and a skid starting: a scrub)
let passClock=0,skidWas=0;
function passFrame(dt){passClock+=dt;if(!(state==='ride'||state==='finish'))return;const v=Math.hypot(P.vx,P.vz);
 if(P.skid>.5&&skidWas<=.5&&v>4)fx('skidStart',Math.min(1,v/12));skidWas=P.skid;
 if(v<6)return;const F={x:-Math.sin(P.th),z:-Math.cos(P.th)};
 nearColliders(P.x,P.z,o=>{if(o.kind==='log')return;const dx=o.x-P.x,dz=o.z-P.z,f=dx*F.x+dz*F.z;
  const lat=dx*Math.cos(P.th)-dz*Math.sin(P.th),gap=Math.abs(lat)-o.r;   // lat > 0: on the rider's right
  if(f>-.6&&f<.6&&gap<2.6&&passClock-(o._pass||-9)>1.5){o._pass=passClock;fx('treePass',clamp(v/22,0,1)*(1-gap/2.6),{pan:Math.sign(lat)});}});}
// continuous feel, every frame: a rumble that follows the ground, brake shudder, a fine buzz as the tyres near
// the limit of grip, rocks and roots as knocks, and plank seams ticking under you on the woodwork
let plankAcc=0;
function feelFrame(dt){
 if(!(state==='ride'||state==='finish')||!P.ground){HAP.rumble(0,0,dt);return;}
 const v=Math.hypot(P.vx,P.vz),sp=Math.min(1,v/14),rock=P.deck?0:SW[3];
 let i=sp*(.05+P.rough*.5),s=P.deck?.6:.22+rock*.5;
 i+=input.brake*Math.min(1,v/8)*.16;
 if(P.skid>.2){i+=P.skid*.25*Math.min(1,v/6);s=lerp(s,.1,P.skid);}
 const gu=smooth(.7,1.05,P.gripUse||0);i+=gu*.18*Math.min(1,v/5);s=lerp(s,.9,gu*.6);
 HAP.rumble(i,s,dt);
 if(P.deck){plankAcc+=v*dt;const gap=Math.max(.14,v/22);if(plankAcc>gap){plankAcc=plankAcc>2*gap?0:plankAcc-gap;HAP.tap(.1+.12*sp,.95);}}
 else if(Math.random()<v*P.rough*(.5+rock*1.6)*dt)HAP.tap((.12+Math.random()*.3)*(.6+rock*.8)*(.4+sp*.6),.45+rock*.45);}

// respawn on a breadcrumb laid a couple of seconds before the crash, clear of trees
function clearAhead(x,z,th,len){let ok=true;const fx=-Math.sin(th),fz=-Math.cos(th);
 nearColliders(x,z,o=>{if(!ok)return;const dx=o.x-x,dz=o.z-z,f=dx*fx+dz*fz,l=Math.abs(-dx*fz+dz*fx);if(f>-1.5&&f<len&&l<o.r+1.4)ok=false;});
 nearColliders(x+fx*len,z+fz*len,o=>{if(!ok)return;const dx=o.x-x,dz=o.z-z,f=dx*fx+dz*fz,l=Math.abs(-dx*fz+dz*fx);if(f>-1.5&&f<len&&l<o.r+1.4)ok=false;});return ok;}
// Respawn on a breadcrumb laid a couple of seconds before the crash, facing a clear line (turning toward
// the next gate or downhill if needed). Repeated crashes step further back along the route.
let lastResp={t:-99,n:0};
function respawnPoint(){const now=P.clock||0;lastResp.n=now-lastResp.t<6?lastResp.n+1:0;lastResp.t=now;const back=1.8+lastResp.n*1.5;
 for(let k=crumbs.length-1;k>=0;k--){const c=crumbs[k];if(now-c.t<back)continue;
  const t=target();const goal=t?headingTo(c.x,c.z,t.x,t.z):0;
  for(const off of[0,.35,-.35,.7,-.7,1.05,-1.05]){const th=lerp(c.th,c.th+wrapA(goal-c.th),.3)+off;if(clearAhead(c.x,c.z,th,24)||c.y>heightAt(c.x,c.z)+.3){crumbs.length=Math.max(1,k+1-lastResp.n*2);return {x:c.x,z:c.z,y:c.y,th:c.y>heightAt(c.x,c.z)+.3?c.th:th};}}}
 return {x:START.x,z:START.z-1,th:0};}
function crash(reason){if(state!=='ride')return;setFirstPerson(false);input.hopHeld=false;state='crash';crashT=0;crashes++;timeScale=.3;shake=1;fx('crash');
 $('crA').textContent=reason;show(['crashmsg'],true);
 const v=V3(P.vx,P.vy,P.vz);
 scene.attach(rider);crashBodies.push({o:rider,v:v.clone().multiplyScalar(.9).add(V3(0,3.5,0)),w:V3((Math.random()-.5)*8,(Math.random()-.5)*4,(Math.random()-.5)*8),r:.35});
 crashBodies.push({o:bikeBody,v:v.clone().multiplyScalar(.6).add(V3(0,2,0)),w:V3((Math.random()-.5)*6,(Math.random()-.5)*6,(Math.random()-.5)*10),r:.35,local:true});
 for(let i=0;i<28;i++)dust.spawn(P.x,P.y+.2,P.z,(Math.random()-.5)*6+P.vx*.3,Math.random()*2.5,(Math.random()-.5)*6+P.vz*.3,1.5,.8,.3);}
const target=()=>mode==='race'?(gateIdx<GATES.length?GATES[gateIdx]:FINISH):null;
const balSec=()=>P.deck&&P.deck.st&&P.deck.st.balance!=null?P.deck.st.balance:-1;

// ───────────────────────── physics
// assist: in a race, gently aim for the next gate; always, steer away from trunks and boulders just ahead
let courseIdx=0;
function assistSteer(v,F,R){let om=0,w=0;const t=target();
 if(P.deck){// on woodwork: hold the middle of the deck and follow it (only a light hand on skinnies: balancing is the point)
  const d=P.deck,pts=d.st.pts,ahead=pts[Math.min(pts.length-1,d.i+1+Math.round(v*.35))],thA=Math.atan2(-ahead.tx,-ahead.tz),thT=Math.atan2(-d.tx,-d.tz);
  // feed-forward the bend coming up (riders look ahead and lean early) plus heading and side-offset correction
  const kap=wrapA(thA-thT)/Math.max(1,1+Math.round(v*.35)),goal=lerp(thT,thA,.5)+Math.atan((d.w<.75?3:1.8)*d.lat/(v+1.2)),sk=d.w<.75&&!DEV.fullAssist;
  return {om:clamp(kap*v+(sk?2.6:4.5)*wrapA(goal-P.th),-2.5,2.5),w:sk?.42:.92,deck:true};}
 if(mode==='skinny'&&CORE.BALANCE.sections.length){// line up with the next section's entry
  const B=CORE.BALANCE,st=STRUCTS[B.sections[Math.min(B.sections.length-1,Math.max(0,SK.sec+(SK.onSec>=0?1:0)))]],q=st.pts[0],q1=st.pts[Math.min(2,st.pts.length-1)];
  const lead={x:q.x-q.tx*2.5,z:q.z-q.tz*2.5},d=Math.hypot(lead.x-P.x,lead.z-P.z),aim=d>1.5?lead:q1;return {om:clamp(2.4*wrapA(headingTo(P.x,P.z,aim.x,aim.z)-P.th),-1.6,1.6),w:.8};}
 if(t&&COURSE.length&&mode==='race'){// Shoreline: follow the main line (singletrack and woodwork) toward the gate
  let bi=courseIdx,bd=1e9;for(let k=Math.max(0,courseIdx-40);k<Math.min(COURSE.length,courseIdx+120);k++){const c=COURSE[k],d=(c.x-P.x)**2+(c.z-P.z)**2;if(d<bd){bd=d;bi=k;}}
  if(bd>900){for(let k=0;k<COURSE.length;k+=4){const c=COURSE[k],d=(c.x-P.x)**2+(c.z-P.z)**2;if(d<bd){bd=d;bi=k;}}}
  courseIdx=bi;let la=Math.round(7+v*.7);for(let k=bi;k<Math.min(COURSE.length,bi+14);k++)if(COURSE[k].deck){la=Math.min(la,Math.max(2,k-bi+2));break;}
  const a=COURSE[Math.min(COURSE.length-1,bi+la)];om=clamp(2.6*wrapA(headingTo(P.x,P.z,a.x,a.z)-P.th),-1.6,1.6);w=.6;}
 else if(t){om=clamp(2.2*wrapA(headingTo(P.x,P.z,t.x,t.z)-P.th),-1.4,1.4);w=.5;}
 const reach=4+v*1.1;let push=0;
 nearColliders(P.x,P.z,o=>{const dx=o.x-P.x,dz=o.z-P.z,fwd=dx*F.x+dz*F.z,lat=dx*R.x+dz*R.z,clear=o.r+1.7;
  if(fwd>.5&&fwd<reach&&Math.abs(lat)<clear)push+=(lat>=0?1:-1)*(1-fwd/reach)*(clear-Math.abs(lat));});
 if(push){om+=clamp(push*2.6,-3,3);w=Math.max(w,.9);}
 return {om,w};}
function step(dt){
 const F={x:-Math.sin(P.th),z:-Math.cos(P.th)},Rv={x:Math.cos(P.th),z:-Math.sin(P.th)};
 const live=state==='ride'||state==='finish';
 const steer=live&&state!=='finish'?input.steer:0;let brake=state==='finish'?1:live?input.brake:0;
 if(P.ground){
  const e=.6;
  const gF=(surf(P.x+F.x*e,P.z+F.z*e)-surf(P.x-F.x*e,P.z-F.z*e))/(2*e);
  const gR=(surf(P.x+Rv.x*e,P.z+Rv.z*e)-surf(P.x-Rv.x*e,P.z-Rv.z*e))/(2*e);
  const dk=deckAt(P.x,P.z,P.y);if(dk)P.lastLat=dk.lat;P.deck=dk&&Math.abs(P.y-dk.y)<.25&&dk.y>heightAt(P.x,P.z)-.05?dk:null;
  surfaceInto(P.x,P.z,1/Math.hypot(gF,1,gR),SW);const feel=P.deck?WOOD_FEEL:rideFeel(SW);P.rough=feel.rough;
  // the suspension working over roots and stones: small random kicks scaled by speed
  {const vv=Math.abs(P.vx*F.x+P.vz*F.z),kick=(Math.random()-.5)*feel.rough*Math.min(1,vv/12)*.75;suspKick(kick,kick,vv);}
  let vf=P.vx*F.x+P.vz*F.z,vl=P.vx*Rv.x+P.vz*Rv.z;
  // vf is horizontal; the bike moves along the slope at vs = vf/cosθ. Forces act along the path, so integrate vs and
  // turn it back into horizontal speed — otherwise steep ground would carry you sideways faster than gravity can.
  const cA=1/Math.sqrt(1+gF*gF);let vs=vf/cA;
  // assist keeps open-slope speeds sane: a gentle brake above ~63 km/h
  // (earlier on steep ground, where the brakes can do less before you'd pitch over the bars)
  P.autoBrake=0;{const vMax=17.5-6*clamp(-gF-.35,0,.5);if(assist&&state==='ride'&&!brake&&vs>vMax){brake=clamp((vs-vMax)/4,0,1);P.autoBrake=brake;}}
  // rider + bike ≈ 100 kg, CdA ≈ 0.5 m² in the attack position → ½ρCdA/m ≈ 0.003
  const DRAG=.003,MASS=100;
  let a=-G*gF*cA-feel.roll*cA*Math.sign(vs)-DRAG*(1-.22*Math.max(0,input.lean))*vs*Math.abs(vs)-.045*feel.rough*vs;
  // pedalling: ~750 W sprint, auto-pedals on flatter ground; DH gearing spins out above ~48 km/h
  const narrow=P.deck&&P.deck.w<.75;
  if(mode==='skinny'&&state==='ride'&&!brake&&vs>(narrow?4.2:6)){brake=clamp((vs-(narrow?4.2:6))/2,0,.8);}
  P.pedal=live&&state!=='finish'&&!brake&&vs<(mode==='skinny'?3.4:13.3)&&(gF>-.12||vs<6);if(P.pedal)a+=Math.min(2.6,750/(MASS*Math.max(vs,2)))*(1-smooth(11.5,13.3,vs));
  // brakes: both wheels together can use most of the tyres' grip (the rest is left for steering)
  // weight fore/aft: tilt (or, braking on the button, an instinctive shift back). It sets where your mass sits
  // over the wheels: back raises the braking limit on steep ground; forward weights the front tyre for corners.
  const fore=clamp(input.lean-Math.max(.8*input.btnBrake,P.autoBrake),-1,1);P.fore=fore;
  // brakes: both wheels together can use most of the tyres' grip (the rest is left for steering) — but no more than
  // tips you over the front wheel. Moments about the front contact: braking force·h ≥ g·cosα·x pitches you over,
  // with x the mass's distance behind the front axle (≈0.62 m neutral, 0.9 m hips back, 0.34 m over the bars)
  // and h its height (≈1.05 m). On a 30° slope that limit is ~0.5 g neutral and ~0.8 g with your weight back.
  const cosA=1/Math.sqrt(1+gF*gF),tipLim=G*cosA*(.62-.28*fore)/(1.05-.1*Math.abs(fore));
  const bRaw=brake*feel.grip*G*.92*Math.min(1,vs/1.2),bDecel=Math.min(bRaw,tipLim);if(brake)a-=bDecel;P.bDec=bDecel;
  P.stoppie=damp(P.stoppie||0,clamp((bRaw-tipLim)/(.25*G),0,1),10,dt);
  // grabbing a fistful with your weight over the bars at speed: over you go
  if(state==='ride'&&bRaw-tipLim>.35*G&&vf>4&&fore>.3){crash('Over the bars');return;}
  vs=Math.max(0,vs+a*dt);vf=vs*cA;
  // steering: the thumb sets a lean angle; the lean (with its own inertia) carves the turn, ω = g·tanθ / v.
  // At walking pace the bars steer directly instead.
  const v=vs,LEAN_MAX=.85,dmax=lerp(.55,.11,clamp(v/18,0,1));
  let leanT=-steer*LEAN_MAX,delta=-steer*dmax;
  if(assist&&state==='ride'){const A=assistSteer(v,F,Rv);if(A.w){const w=A.w*(Math.abs(steer)>.08?(A.deck?.6:.3):1);
   leanT=lerp(leanT,clamp(Math.atan(A.om*v/G),-LEAN_MAX,LEAN_MAX),w);delta=lerp(delta,clamp(Math.atan(A.om*WB/Math.max(v,.5)),-dmax,dmax),w);}}
  if(state==='finish'){leanT=0;delta=0;}
  // balance: on a narrow plank the bike's heading wanders (an unstable drift, calmer with speed); you correct it
  if(narrow&&state==='ride'){const inst=1.2*(1-smooth(1.5,6.5,v));P.wob=clamp((P.wob||0)+((Math.random()-.5)*1.6*(.3+inst)+(P.wob||0)*inst*.9)*dt,-.5,.5);}else P.wob=(P.wob||0)*Math.exp(-4*dt);
  P.leanV+=(SENS().k*(leanT-P.lean)-SENS().c*P.leanV)*dt;P.lean=clamp(P.lean+P.leanV*dt,-1,1);
  let om=lerp(v*Math.tan(delta)/WB,G*Math.tan(P.lean)/Math.max(v,2),smooth(2.5,6,v))+(P.wob||0)*.5;
  // brake + hard steer at speed = rear-wheel skid turn: pivots the bike, scrubs speed
  const skidTurn=input.brake>.4&&state==='ride'&&v>5&&Math.abs(steer)>.3;if(skidTurn){om+=-steer*1.25*brake;vf=Math.max(0,vf-2.2*brake*dt);}
  P.om=om;P.th+=om*dt;P.steerA=damp(P.steerA,Math.atan(om*WB/Math.max(v,1.5))*(skidTurn?.3:1),14,dt);
  const vhx=vf*F.x+vl*Rv.x,vhz=vf*F.z+vl*Rv.z;const F2={x:-Math.sin(P.th),z:-Math.cos(P.th)},R2={x:Math.cos(P.th),z:-Math.sin(P.th)};
  let vf2=vhx*F2.x+vhz*F2.z,vl2=vhx*R2.x+vhz*R2.z;
  vl2+=-G*gR/Math.sqrt(1+gR*gR)*dt;
  // friction circle: grip spent braking is not available for cornering
  const latMax=Math.sqrt(Math.max(.05,(feel.grip*G*(1+.6*Math.abs(gR))*(1+.08*fore))**2-bDecel*bDecel));const grip=latMax*dt;
  P.gripUse=damp(P.gripUse||0,Math.min(1.5,Math.abs(vl2)/Math.max(1e-4,grip)),12,dt);
  if(Math.abs(vl2)<=grip){vl2=0;P.skid=damp(P.skid,0,8,dt);}else{vl2-=Math.sign(vl2)*grip;P.skid=Math.min(1,Math.abs(vl2)/3);vf2=Math.max(0,vf2-.35*grip);}
  if(brake&&vf2>3)P.skid=Math.max(P.skid,brake*.5);if(skidTurn)P.skid=Math.max(P.skid,.8);
  // a long uncontrolled slide at speed washes out the front
  P.slideT=(P.skid>.85&&!skidTurn&&vf2>7)?P.slideT+dt:Math.max(0,P.slideT-dt*2);if(state==='ride'&&P.slideT>.75){P.slideT=0;crash('Washed out');return;}
  // pumping: with Hop held, ground that falls away faster than the surrounding slope (backsides of bumps) turns into speed
  P.pumping=false;if(input.hopHeld)input.hopT+=dt;const pk=Math.max(input.hopHeld?1:0,Math.max(0,input.lean));
  if(pk>.05&&live&&state!=='finish'){const gBig=(surf(P.x+F.x*4,P.z+F.z*4)-surf(P.x-F.x*4,P.z-F.z*4))/8;const k=gBig-gF;if(k>.03){vf2+=3.6*k*pk*dt;P.pumping=true;}}
  P.vx=vf2*F2.x+vl2*R2.x;P.vz=vf2*F2.z+vl2*R2.z;
  // a ledge or bank face straight ahead: a fast hit is a crash, a slow one just stops you against it
  if(gF>1.1&&vf2>.5){if(state==='ride'&&vf2>7.5){crash('Hit a ledge');return;}vf2=0;vl2*=.5;shake=Math.max(shake,.4);}
  {const nxx=P.x+P.vx*dt*3,nzz=P.z+P.vz*dt*3,side=deckSide(nxx,nzz);if(side&&!(P.deck&&side.st===P.deck.st)){if(state==='ride'&&vf2>4.5){crash(side.y>P.y+1.1?'Clotheslined':'Hit the woodwork');return;}P.vx=P.vz=0;vf2=0;}}
  // The bike is a rigid body on two tyres a wheelbase apart, not a point on the ground. With both tyres down it sits
  // on the chord between their contacts (bridging dips shorter than the wheelbase) at the pitch of that chord, and
  // keeps the rotation rate the ground gives it. Where the ground falls away under the front tyre faster than the
  // bike can follow (off a step, over the lip of a steep roll-in, cresting at speed) nothing holds the front up: it
  // rotates nose-down about the rear contact under gravity, α = g·(d·cosθ − 0.25·sinθ)/(k²+d²+h²), with the mass
  // d ≈ 0.66 m ahead of the rear axle (0.42 m with your weight right back) and h ≈ 1.05 m up — the rider stays
  // upright over the cranks as the bike pitches, so the lever arm stays forward of the rear contact. The rear tyre carries
  // it until the rear goes over the edge too, and then you're in the air with that rotation. So at walking pace the
  // nose drops before the rear reaches the edge (a nose-dive); at speed you're past the edge first and fly off level.
  const nx=P.x+P.vx*dt,nz=P.z+P.vz*dt,yb=P.y+P.vy*dt-.5*G*dt*dt;
  const hR=surf(nx-F2.x*WB/2,nz-F2.z*WB/2),hFw=surf(nx+F2.x*WB/2,nz+F2.z*WB/2),gp=Math.atan2(hFw-hR,WB);
  const placed=!(P.bp>-9);if(placed){P.bp=gp;P.bpw=0;}           // just placed: sit on the ground
  if(gp>=P.bp-.002){                                              // the ground carries the front
   const gpw=clamp((gp-P.bp)/dt,-3,3);
   if(P.frontFree){const vImp=Math.max(0,gpw-P.bpw)*WB*Math.cos(gp);P.sFV+=Math.min(3.5,vImp*.8);
    if(live&&vImp>1.2)fx('land',vImp/9);if(state==='ride'&&vImp>7.5){crash('Over the bars');return;}}
   // the rotation the ground gives the bike, low-passed so the texture of the dirt doesn't turn into spin
   P.bpw=P.frontFree?0:damp(P.bpw,clamp(gpw,-1.5,1.5),8,dt);P.bp=gp;P.frontFree=false;}
  else{const d=clamp(.66+.24*fore,.42,.9),th=P.bp;           // the front is unsupported
   P.bpw-=G*(d*Math.cos(th)-.25*Math.sin(th))/(.12+d*d+1.1)*dt;P.bp=clamp(Math.max(gp,P.bp+P.bpw*dt),-1.35,1.35);P.frontFree=gp<P.bp-.03;}
  // the centre rides on the rear contact and the body's pitch; the frame can't sink more than 0.3 m into a crest
  // (the contacts are sampled a wheelbase apart horizontally, so heights along the body go with tan of its pitch)
  const yc=Math.max(hR+WB/2*Math.tan(P.bp),surf(nx,nz)-.3);
  if(yc<yb-.045&&vf2>2){P.ground=false;P.air=0;P.leanRef=input.lean;P.flip=0;P.flipW=0;P.flipHold=0;P.whip=0;P.whipMax=0;P.airOff=0;P.airOffV=0;P.airPitch=P.bp;P.airW=clamp(P.bpw,-2,2);P.frontFree=false;P.x=nx;P.z=nz;P.y=yb;P.vy-=G*dt;}
  else{const nvy=placed?0:clamp((yc-P.y)/dt,-40,Math.max(4,vf2*1.2));{const dv=clamp((nvy-P.vy)*.3,-1.5,2.5);P.sFV+=dv;P.sRV+=dv;}P.vy=nvy;P.x=nx;P.z=nz;P.y=yc;}
  if(input.hop&&live&&state!=='finish'){input.hop=false;P.ground=false;P.air=0;P.leanRef=input.lean;P.flip=0;P.flipW=0;P.flipHold=0;P.whip=0;P.whipMax=0;P.airOff=0;P.airOffV=0;P.airPitch=P.pitch;P.airW=0;P.frontFree=false;P.vy=Math.max(P.vy,0)+2.9+2.7*input.hopCharge;fx('hop',input.hopCharge);P.sFV=P.sRV=-1.2;}
  P.wheel+=vf2*dt/.39;if(P.pedal)P.crank+=dt*(5+vf2*.5);
 }else{
  P.deck=null;P.air+=dt;P.vy-=G*dt;P.vx*=1-.0025*dt*10;P.vz*=1-.0025*dt*10;
  if(live){if(Math.abs(steer)>.08)P.whip=clamp(P.whip-steer*3.4*dt,-1.2,1.2);else P.whip=damp(P.whip,0,3.2,dt);P.th-=steer*.25*dt;
   // air control: steering bends the flight path a little
   const oa=-steer*.3,ca=Math.cos(oa*dt),sa=Math.sin(oa*dt),nvx=P.vx*ca+P.vz*sa,nvz=-P.vx*sa+P.vz*ca;P.vx=nvx;P.vz=nvz;P.th+=oa*dt;}
  P.whipMax=Math.max(P.whipMax,Math.abs(P.whip));
  // body english in the air: Brake = lean back (nose up), Hop = push the bars down (nose down)
  P.leanRef=damp(P.leanRef||0,0,2.2,dt);
  const pc=live&&state==='ride'?clamp((input.brakeAir?1:0)-(input.hopAir?1:0)-(input.lean-P.leanRef)*1.2,-1,1):0;
  P.airOffV+=(pc*5.5-P.airOffV*2.5)*dt;if(Math.abs(pc)<.05)P.airOff=damp(P.airOff,0,1.1,dt);P.airOff=clamp(P.airOff+P.airOffV*dt,-1.3,1.3);
  // a rider naturally sets the bike to the ground below; body english (airOff) overrides it
  {const Fa={x:-Math.sin(P.th),z:-Math.cos(P.th)};const gb=(surf(P.x+Fa.x*.8,P.z+Fa.z*.8)-surf(P.x-Fa.x*.8,P.z-Fa.z*.8))/1.6;
   P.airPitch=damp(P.airPitch,lerp(Math.atan2(P.vy,Math.hypot(P.vx,P.vz))*.8,Math.atan(gb),.6)+P.airOff,3.5,dt);}
  // flips: keep pulling (or pushing) past the bike's normal range for a moment and you commit to the rotation.
  // Holding on keeps it spinning at ~1 turn per 0.85 s; letting go opens you up and it slows, so let go early
  // enough to stop with the wheels matching the landing — or it's a crash.
  if(live&&state==='ride'&&Math.abs(pc)>.75&&Math.abs(P.airOff)>1.2&&P.air>.2)P.flipHold=(P.flipHold||0)+dt;else P.flipHold=0;
  if(P.flipHold>.3||(P.flipW&&Math.abs(pc)>.75&&Math.sign(pc)===Math.sign(P.flipW)))P.flipW=damp(P.flipW||0,Math.sign(pc)*7.4,3,dt);
  else if(P.flipW)P.flipW=damp(P.flipW,0,4.5,dt);
  P.flip=(P.flip||0)+(P.flipW||0)*dt;
  // the rotation the bike left the ground with carries on, the rider's arms soaking most of it up within ~0.3 s
  if(P.airW){P.airPitch+=P.airW*dt;P.airW=damp(P.airW,0,3.2,dt);}
  P.x+=P.vx*dt;P.z+=P.vz*dt;P.y+=P.vy*dt;P.wheel+=Math.hypot(P.vx,P.vz)*dt/.39*.98;
  const h=surf(P.x,P.z);
  if(P.y<=h){const e=.5;const gx=(surf(P.x+e,P.z)-surf(P.x-e,P.z))/(2*e),gz=(surf(P.x,P.z+e)-surf(P.x,P.z-e))/(2*e);
   const n=V3(-gx,1,-gz).normalize();const vd=P.vx*n.x+P.vy*n.y+P.vz*n.z,vn=-vd;
   P.y=h;P.ground=true;
   // speed into the ground: 8.5 m/s is a 3.7 m drop to flat (the trials world record to flat is 4.1–5.15 m); past it
   // you crash. A 220 mm DH bike bottoms out from ~6 m/s (a 1.8 m drop to flat). Landing on a transition is gentle:
   // only the speed INTO the slope counts.
   if(live&&state==='ride'&&vn>(assist?10:8.5)){crash(P.air>.25?'Cased it':'Too hard');return;}
   if(vn>6){const k=.75;P.vx*=k;P.vz*=k;shake=1;fx('bottom');if(state==='ride')pop('Bottomed out','bad');}
   if(live&&state==='ride'&&Math.abs(P.whip)>.8){crash('Sideways');return;}
   const Fh={x:-Math.sin(P.th),z:-Math.cos(P.th)};const slope=Math.atan(gx*Fh.x+gz*Fh.z),turns=Math.round((P.flip||0)/(Math.PI*2)),miss=P.airPitch+(P.flip||0)-turns*Math.PI*2-slope;
   if(live&&state==='ride'&&P.air>.35){if(miss<-.8){crash('Nosed in');return;}if(miss>1.0){crash('Looped out');return;}}
   P.landMiss=miss;P.bpw=0;P.frontFree=false;
   // settle onto both tyres: the same two-contact height the ground model uses, so landing in a dip doesn't bounce
   {const hRl=surf(P.x-Fh.x*WB/2,P.z-Fh.z*WB/2),hFl=surf(P.x+Fh.x*WB/2,P.z+Fh.z*WB/2);P.bp=Math.atan2(hFl-hRl,WB);P.y=Math.max(P.y,(hRl+hFl)/2);}
   P.vx-=vd*n.x;P.vy-=vd*n.y;P.vz-=vd*n.z;
   {const wF=clamp(.45-miss*.9,.15,.85),v0=vn*.32;P.sFV+=v0*wF*2;P.sRV+=v0*(1-wF)*2;}shake=Math.max(shake,Math.min(.8,vn*.05));if(live)camK.v-=Math.min(3.2,vn*.32);
   const air=P.air;if(air<=.3&&vn>2.5&&live)fx('land',vn/14);
   if(air>.3&&live){fx('land',vn/9);
    for(let i=0;i<26;i++){const a=Math.random()*6.28,sp=1.5+Math.random()*3;dust.spawn(P.x,P.y+.1,P.z,Math.cos(a)*sp+P.vx*.25,.6+Math.random()*1.8,Math.sin(a)*sp+P.vz*.25,1.4+Math.random(),.9+Math.random()*.6,.55);}
    if(state==='ride'){airTotal+=air;const w=Math.round(P.whipMax*57);let pts=Math.round(air*100+(w>20?w*3:0));const clean=vn<5;if(clean)pts+=50;
     const perfect=Math.abs(P.landMiss)<.16,sketchy=Math.abs(P.landMiss)>.45;
     if(perfect&&air>.45){pts+=80;const sp=Math.hypot(P.vx,P.vz);const k=(sp+1.3)/sp;P.vx*=k;P.vz*=k;}
     else if(sketchy){P.vx*=.86;P.vz*=.86;shake=Math.max(shake,.7);}
     let trick='';if(turns){const n=Math.abs(turns);trick=(n===1?'':n===2?'Double ':'Triple ')+(turns>0?'backflip':'frontflip');pts+=n*(turns>0?600:800);fx('trick',n);}
     P.flip=0;P.flipW=0;
     style+=pts;pop(trick||air.toFixed(2)+'s',sketchy?'bad':'tape',(w>20?'whip '+w+'°':perfect?'perfect':sketchy?'sketchy':clean?'clean':'')+(mode==='free'?' +'+pts:''));}}
   P.air=0;}
 }
 // suspension spring
 // suspension: fork and shock as two springs in metres of travel (TRAVEL each end, SAG at rest), ~2 Hz and
 // under-damped like a coil DH bike, progressive into the last 40 mm. Loaded by g-force in corners and
 // compressions, by brake dive (front down, rear up), by pumping; unloaded in the air, where the wheels drop away.
 {const q=P.bq,ri=P.bi%q.length;P.sRV+=q[ri];q[ri]=0;P.bi++;
  let tF=0,tR=0;if(P.ground){const ac=Math.abs((P.om||0)*Math.hypot(P.vx,P.vz)),load=Math.min(2.2,Math.sqrt(1+(ac/G)**2)),bd=(P.bDec||0)/G,pu=P.pumping?.03:0;
   tF=SAG_F*load+bd*.05+pu;tR=SAG*load-bd*.03+pu;}
  // k = g/sag per unit mass (a linear coil carrying the rider's weight at sag): fork 223 (2.4 Hz), shock 140 (1.9 Hz)
  const spr=(s,v,t,k)=>-k*(s-t)-.7*Math.sqrt(k)*v-(s>TRAVEL-.04?5000*(s-TRAVEL+.04)**2:0);
  P.sFV+=spr(P.sF,P.sFV,tF,G/SAG_F)*dt;P.sRV+=spr(P.sR,P.sRV,tR,G/SAG)*dt;P.sF+=P.sFV*dt;P.sR+=P.sRV*dt;
  if(P.sF<0){P.sF=0;if(P.sFV<0)P.sFV=0;}if(P.sF>TRAVEL){P.sF=TRAVEL;if(P.sFV>0)P.sFV*=-.15;}
  if(P.sR<0){P.sR=0;if(P.sRV<0)P.sRV=0;}if(P.sR>TRAVEL){P.sR=TRAVEL;if(P.sRV>0)P.sRV*=-.15;}
  P.susp=clamp(((P.sF+P.sR)/2-SAG)*2.2,-.12,.22);}
 // obstacles and bounds
 if(state==='ride'){let hit=null;nearColliders(P.x,P.z,o=>{if(hit)return;const dx=P.x-o.x,dz=P.z-o.z;if(dx*dx+dz*dz<(o.r+.25)**2&&P.y<(o.top!=null?o.top:heightAt(o.x,o.z)+(o.kind==='tree'?12:o.r*.7)))hit=o;});
  // logs: a 29" wheel rolls over a small one with a thump; a big one stops you unless you're in the air
  if(hit&&hit.kind==='log'&&(hit.r<.62||!P.ground)){if(P.ground&&hit!==P.lastLog){P.lastLog=hit;const k=.82;P.vx*=k;P.vz*=k;P.vy+=1.6;suspKick(.9,.9,Math.hypot(P.vx,P.vz));shake=Math.max(shake,.6);fx('log');}hit=null;}
  if(!hit)P.lastLog=P.lastLog&&Math.hypot(P.x-P.lastLog.x,P.z-P.lastLog.z)<P.lastLog.r+1?P.lastLog:null;
  if(hit){crash(hit.kind==='tree'?'Tree':hit.kind==='log'?'Log':hit.kind==='post'?'Stilt':'Rock');return;}
  if(Math.abs(P.x)>620||P.z<Z_MIN+120||P.z>Z_MAX-40){crash('Out of bounds');return;}
  stuckT=P.spd<1.2&&!input.brakeHeld?stuckT+dt:0;if(stuckT>2.2){stuckT=0;crash('Stalled');}}
 P.spd=Math.hypot(P.vx,P.vy,P.vz);
 // breadcrumbs for respawning (sim clock, so it works however the step is driven)
 P.clock=(P.clock||0)+dt;if(state==='ride'&&P.ground&&P.spd>3){crumbT+=dt;if(crumbT>.5){crumbT=0;crumbs.push({x:P.x,z:P.z,y:P.y,th:Math.atan2(-P.vx,-P.vz),t:P.clock});if(crumbs.length>40)crumbs.shift();}}
}

// ───────────────────────── per-frame visuals
const _q=new THREE.Quaternion(),_e=new THREE.Euler();
function updateBikeVisual(dt){
 if(state==='crash')return;
 const F={x:-Math.sin(P.th),z:-Math.cos(P.th)};
 let y=P.y,pitchT;
 if(P.ground){const hf=surf(P.x+F.x*WB/2,P.z+F.z*WB/2),hr=surf(P.x-F.x*WB/2,P.z-F.z*WB/2);
  // the physics body's height and pitch (it rests on its two tyre contacts)
  y=P.y;const bpv=P.bp>-9?P.bp:Math.atan2(hf-hr,WB);
  // at the braking limit the rear wheel lifts: pivot about the front contact
  const st=(P.stoppie||0)*.16;P.pitch=bpv-st;y+=WB/2*Math.sin(st);}
 else{P.pitch=P.airPitch+(P.flip||0);}
 const rollT=P.ground?P.lean:-P.whip*.55;P.roll=P.ground?damp(P.roll,rollT,25,dt):damp(P.roll,rollT,5,dt);
 // the axles rise into the frame as the suspension works: front along the 63° steering axis, rear vertically
 const rF=P.sF*.891,rR=P.sR;
 bike.position.set(P.x,y-(rF+rR)/2,P.z);
 bike.rotation.set(P.pitch+(rR-rF)/WB,P.th+(P.ground?0:P.whip),P.roll,'YXZ');
 const crouch=clamp(.25+P.susp*2.2+input.brake*.25+(P.ground?0:.15)+P.spd/50+(input.hopHeld?.4:0),0,1);
 const fore=P.ground?clamp(input.lean,-1,1)*.9+(P.pumping?.25:0):clamp(-P.airOff*.7,-1,1);
 updateBikePose({steer:P.steerA*(P.ground?1.3:.4)+(P.ground?0:-P.whip*.25),wheel:P.wheel,crank:P.crank,crouch,lean:P.roll*.8,air:!P.ground,brake:input.brake,fore,sF:P.sF,sR:P.sR,dt});
}
const _tmp=new THREE.Vector3();
function updateCrashBodies(dt){for(const b of crashBodies){b.v.y-=G*dt;
  if(b.local){/* bikeBody is a child of bike: move bike instead */const o=bike;o.position.addScaledVector(b.v,dt);
   _q.setFromEuler(_e.set(b.w.x*dt,b.w.y*dt,b.w.z*dt));o.quaternion.multiply(_q);
   const h=heightAt(o.position.x,o.position.z);if(o.position.y<h+.05){o.position.y=h+.05;b.v.y=Math.abs(b.v.y)*.3;b.v.x*=.8;b.v.z*=.8;b.w.multiplyScalar(.75);}}
  else{const o=b.o;o.position.addScaledVector(b.v,dt);_q.setFromEuler(_e.set(b.w.x*dt,b.w.y*dt,b.w.z*dt));o.quaternion.multiply(_q);
   const h=heightAt(o.position.x,o.position.z);if(o.position.y<h-.6){o.position.y=h-.6;b.v.y=Math.abs(b.v.y)*.3;b.v.x*=.75;b.v.z*=.75;b.w.multiplyScalar(.7);
    if(Math.hypot(b.v.x,b.v.z)>2)for(let i=0;i<3;i++)dust.spawn(o.position.x,h+.1,o.position.z,(Math.random()-.5)*2,Math.random()*1.5,(Math.random()-.5)*2,1.3,1,.5);}}}}


const fp={yaw:0,pitch:0,roll:0};
// camera shake as smooth noise (sums of incommensurate sines), never per-frame random jumps, which read as glitches.
// shake (trauma, 0..1) gives the big knocks; roughness a fine buzz; camK is a spring the camera drops on at landings.
let camT=0;const camK={y:0,v:0};
const sn=(t,k)=>Math.sin(t+k)*.5+Math.sin(t*2.31+k*1.7)*.3+Math.sin(t*4.47+k*2.9)*.2;
let view=store.get('view')==='helmet'?'helmet':'chase';
function setView(v){view=v;store.set('view',v);setFirstPerson(v==='helmet'&&state!=='crash');camera.near=v==='helmet'?.05:.15;camera.updateProjectionMatrix();
 fp.yaw=P.th;fp.pitch=0;fp.roll=0;const b=$('viewBtn');b.classList.toggle('fp',v==='helmet');b.setAttribute('aria-label',v==='helmet'?'Switch to chase cam':'Switch to helmet cam');b.title=b.getAttribute('aria-label');}
function updateCamera(dt){
 camT+=dt;shake=Math.max(0,shake-dt*2.4);camK.v+=(-150*camK.y-15*camK.v)*dt;camK.y=clamp(camK.y+camK.v*dt,-.35,.2);
 const F=V3(-Math.sin(P.th),0,-Math.cos(P.th));
 if(state==='title'||state==='loading'){camS.orbit+=dt*.1;const a=camS.orbit;const c=V3(P.x,P.y,P.z);
  const pos=c.clone().add(V3(Math.sin(a)*6.5,2.1+Math.sin(a*.7)*.6,Math.cos(a)*6.5));camera.position.lerp(pos,1-Math.exp(-3*dt));camS.look.lerp(c.clone().add(V3(0,1,0)),1-Math.exp(-4*dt));camera.lookAt(camS.look);camera.fov=50;camera.updateProjectionMatrix();return;}
 if(state==='crash'){const t=rider.position;camS.look.lerp(V3(t.x,t.y,t.z),1-Math.exp(-5*dt));camera.lookAt(camS.look);return;}
 const sp0=Math.hypot(P.vx,P.vz);
 if(view==='helmet'&&state!=='finish'){
  // helmet cam: eye position from the rider's head; gaze steadier than the bike and looking into the turn
  eye.getWorldPosition(_tmp);
  let yawT=P.th+(P.ground?clamp(P.om*.28,-.35,.35):P.whip*.55);
  fp.yaw+=wrapA(yawT-fp.yaw)*(1-Math.exp(-9*dt));
  const flp=P.ground?0:(P.flip||0);fp.pitch=damp(fp.pitch,(P.pitch-flp)*.7+(eye.userData.fpPitch??-.33)-P.susp*.5,8,dt);fp.roll=damp(fp.roll,P.roll*.38,6,dt);
  // a little behind and above the eyes, like a helmet-top camera, so the bars show at the bottom of the frame
  camera.position.copy(_tmp).add(V3(Math.sin(fp.yaw)*.34,.14+camK.y*.6,Math.cos(fp.yaw)*.34));
  const tr=shake*shake,rough=P.ground?(.1+P.rough)*Math.min(1,sp0/10):0;
  const jp=tr*.05*sn(camT*22,1)+rough*.006*sn(camT*31,4)+camK.y*.35,jy=tr*.04*sn(camT*19,7),jr=tr*.05*sn(camT*17,9);
  camera.position.y+=rough*.012*sn(camT*27,2);
  camera.rotation.set(fp.pitch+flp+jp,fp.yaw+jy,fp.roll+jr,'YXZ');
  const hf=THREE.MathUtils.degToRad(96+clamp(sp0-6,0,20)*.7);const vf=clamp(THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(hf/2)/camera.aspect)),70,92);
  camS.fov=damp(camS.fov,vf,3,dt);camera.fov=camS.fov;camera.updateProjectionMatrix();
  camS.dir.set(-Math.sin(fp.yaw),0,-Math.cos(fp.yaw));camS.look.copy(camera.position).addScaledVector(camS.dir,4);return;}
 const sp=Math.hypot(P.vx,P.vz);const vd=sp>1?V3(P.vx/sp,0,P.vz/sp):F;camS.dir.lerp(vd,1-Math.exp(-(state==='finish'?1:4)*dt)).normalize();
 const dist=4.4+Math.min(sp,22)*.07,ht=1.75+Math.min(sp,22)*.025;
 const want=V3(P.x,P.y,P.z).addScaledVector(camS.dir,-dist);want.y=Math.max(P.y+ht,heightAt(want.x,want.z)+1.1);
 if(state==='finish'){camS.orbit+=dt*.25;want.add(V3(Math.cos(camS.orbit)*3,.5,Math.sin(camS.orbit)*3));}
 camera.position.x=damp(camera.position.x,want.x,8,dt);camera.position.z=damp(camera.position.z,want.z,8,dt);camera.position.y=damp(camera.position.y,want.y,P.ground?7:4,dt);
 const ch=heightAt(camera.position.x,camera.position.z)+.7;if(camera.position.y<ch)camera.position.y=ch;
 const look=V3(P.x,P.y+1,P.z).addScaledVector(camS.dir,3.2);camS.look.lerp(look,1-Math.exp(-10*dt));camera.lookAt(camS.look);
 const tr=shake*shake,rough=P.ground?P.rough*Math.min(1,sp/12):0;
 camera.position.y+=camK.y+rough*.018*sn(camT*26,2);camera.rotateX(tr*.04*sn(camT*21,1));camera.rotateY(tr*.035*sn(camT*18,5));
 camera.rotateZ(-P.roll*.12+tr*.04*sn(camT*16,8));
 camS.fov=damp(camS.fov,60+clamp(sp-6,0,20)*.75,3,dt);camera.fov=camS.fov;camera.updateProjectionMatrix();
}

// ───────────────────────── HUD: minimap and gate arrow
// The minimap is a shaded relief of the whole mountain (built once at 6 m/px); the HUD shows a 420 m window, heading-up.
const MAP_S=6,MAP_W=Math.round((X_MAX-X_MIN)/MAP_S),MAP_H=Math.round((Z_MAX-Z_MIN)/MAP_S);let mapImg=null;
async function buildMap(progress){const c=document.createElement('canvas');c.width=MAP_W;c.height=MAP_H;const x2=c.getContext('2d');const im=x2.createImageData(MAP_W,MAP_H);const w=[0,0,0,0];
 for(let py=0;py<MAP_H;py++){const z=Z_MAX-py*MAP_S;for(let px=0;px<MAP_W;px++){const x=X_MIN+px*MAP_S,h=heightAt(x,z),gx=heightAt(x+2,z)-h,gz=heightAt(x,z-2)-h;
   surfaceInto(x,z,1/Math.hypot(gx/2,1,gz/2),w);const sh=clamp(.82+(-gx+gz)*.32,.35,1.25),fr=forestAt(x,z);
   const r=(w[0]*168+w[1]*128+w[2]*52+w[3]*150)*sh*(1-fr*.25),g=(w[0]*120+w[1]*150+w[2]*84+w[3]*145)*sh,b=(w[0]*82+w[1]*74+w[2]*52+w[3]*138)*sh*(1-fr*.2);
   const k=(py*MAP_W+px)*4;im.data[k]=r;im.data[k+1]=g;im.data[k+2]=b;im.data[k+3]=255;}
  if(py%40===0){progress&&progress(py/MAP_H);await new Promise(r=>setTimeout(r,0));}}
 x2.putImageData(im,0,0);
 // features as small marks
 x2.fillStyle='rgba(255,230,190,.9)';for(const f of featureList(X_MIN,Z_MIN,X_MAX,Z_MAX)){x2.fillRect((f.x-X_MIN)/MAP_S-1,(Z_MAX-f.z)/MAP_S-1,2,2);}
 // raised woodwork and singletrack
 x2.lineCap='round';x2.strokeStyle='rgba(214,160,96,.95)';x2.lineWidth=1.6;for(const st of STRUCTS){x2.beginPath();st.pts.forEach((p,i)=>{const X=(p.x-X_MIN)/MAP_S,Y=(Z_MAX-p.z)/MAP_S;i?x2.lineTo(X,Y):x2.moveTo(X,Y);});x2.stroke();}
 x2.strokeStyle='rgba(120,84,50,.9)';x2.lineWidth=1;for(const ln of CORE.LINES){x2.beginPath();ln.forEach((p,i)=>{const X=(p.x-X_MIN)/MAP_S,Y=(Z_MAX-p.z)/MAP_S;(i&&!p.gap)?x2.lineTo(X,Y):x2.moveTo(X,Y);});x2.stroke();}
 // carved trails: the race trail brighter
 for(const T of CORE.TRAILS){x2.strokeStyle=T.main?'rgba(255,140,70,.95)':'rgba(190,120,70,.85)';x2.lineWidth=T.main?2:1.4;x2.beginPath();T.pts.forEach((p,i)=>{const X=(p.x-X_MIN)/MAP_S,Y=(Z_MAX-p.z)/MAP_S;i?x2.lineTo(X,Y):x2.moveTo(X,Y);});x2.stroke();}
 mapImg=c;}
const mm=$('minimap'),mctx=mm.getContext('2d');
function drawMinimap(){const w=mm.clientWidth,h=mm.clientHeight;if(!w||!mapImg)return;const dpr=Math.min(2,devicePixelRatio||1);if(mm.width!==w*dpr){mm.width=w*dpr;mm.height=h*dpr;}
 const W=mm.width,H=mm.height,R=420,sc=W/R;mctx.save();mctx.clearRect(0,0,W,H);
 mctx.beginPath();mctx.arc(W/2,H/2,W/2,0,7);mctx.clip();mctx.fillStyle='#1a1f17';mctx.fillRect(0,0,W,H);
 mctx.translate(W/2,H/2);mctx.rotate(P.th);// heading-up: forward (−z) points to the top
 const px=(P.x-X_MIN)/MAP_S,pz=(Z_MAX-P.z)/MAP_S;mctx.scale(sc*MAP_S,sc*MAP_S);mctx.drawImage(mapImg,-px,-pz);
 if(mode==='race'){GATES.forEach((g,k)=>{if(k<gateIdx)return;mctx.fillStyle=k===gateIdx?'#ff5f1f':'rgba(244,239,228,.85)';mctx.beginPath();mctx.arc((g.x-X_MIN)/MAP_S-px,(Z_MAX-g.z)/MAP_S-pz,(k===gateIdx?7:4)/(sc*MAP_S),0,7);mctx.fill();});
  mctx.fillStyle='#b4cf72';mctx.beginPath();mctx.arc((FINISH.x-X_MIN)/MAP_S-px,(Z_MAX-FINISH.z)/MAP_S-pz,6/(sc*MAP_S),0,7);mctx.fill();}
 mctx.restore();
 // rider arrow (always pointing up)
 mctx.fillStyle='#f4efe4';mctx.strokeStyle='#0e110d';mctx.lineWidth=1.5*dpr;mctx.beginPath();mctx.moveTo(W/2,H/2-9*dpr);mctx.lineTo(W/2+6*dpr,H/2+7*dpr);mctx.lineTo(W/2,H/2+3*dpr);mctx.lineTo(W/2-6*dpr,H/2+7*dpr);mctx.closePath();mctx.fill();mctx.stroke();
 mctx.strokeStyle='rgba(244,239,228,.35)';mctx.lineWidth=1.5*dpr;mctx.beginPath();mctx.arc(W/2,H/2,W/2-dpr,0,7);mctx.stroke();}
function drawNav(){const t=target();if(!t)return;const d=Math.hypot(t.x-P.x,t.z-P.z);const rel=wrapA(headingTo(P.x,P.z,t.x,t.z)-(view==='helmet'?fp.yaw:Math.atan2(-camS.dir.x,-camS.dir.z)));
 $('navArrow').style.transform='rotate('+(-rel)+'rad)';$('navTxt').textContent=(gateIdx<GATES.length?'Gate '+(gateIdx+1)+'/'+GATES.length:'Finish')+' · '+Math.round(d)+' m';}

// ───────────────────────── input
const touch=$('touch'),stick=$('stick'),knob=stick.firstElementChild;let steerId=null,sx0=0;
touch.addEventListener('pointerdown',e=>{if(state!=='ride'&&state!=='countdown'&&state!=='crash')return;if(steerId!==null)return;steerId=e.pointerId;sx0=e.clientX;
 stick.style.left=e.clientX+'px';stick.style.top=e.clientY+'px';stick.classList.add('on');knob.style.transform='translateX(0)';try{touch.setPointerCapture(e.pointerId);}catch(_){}$('steerhint').hidden=true;});
touch.addEventListener('pointermove',e=>{if(e.pointerId!==steerId)return;const S=SENS(),r=Math.min(innerWidth,innerHeight)*S.r;const dx=clamp((e.clientX-sx0)/r,-1,1);input.steerT=Math.sign(dx)*Math.pow(Math.abs(dx),S.e);knob.style.transform='translateX('+(dx*40)+'px)';});
const endSteer=e=>{if(e.pointerId!==steerId)return;steerId=null;input.steerT=0;stick.classList.remove('on');};
touch.addEventListener('pointerup',endSteer);touch.addEventListener('pointercancel',endSteer);
function holdBtn(el,on,off){el.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();el.classList.add('on');on();try{el.setPointerCapture(e.pointerId);}catch(_){}});
 const up=e=>{el.classList.remove('on');off&&off();};el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);el.addEventListener('lostpointercapture',up);}
holdBtn($('brake'),()=>{input.brakeHeld=true;input.brakeAir=!P.ground;},()=>{input.brakeHeld=false;input.brakeAir=false;});
holdBtn($('hop'),hopDown,hopUp);
addEventListener('keydown',e=>{const k=e.key;if(k==='ArrowLeft'||k==='a'||k==='A')input.keyL=1;else if(k==='ArrowRight'||k==='d'||k==='D')input.keyR=1;
 else if(k==='ArrowDown'||k==='s'||k==='S'){if(!e.repeat){input.brakeHeld=true;input.brakeAir=!P.ground;}}else if(k===' '||k==='ArrowUp'||k==='w'||k==='W'){if(!e.repeat)hopDown();e.preventDefault();}
 else if(k==='v'||k==='V'||k==='c'||k==='C')setView(view==='helmet'?'chase':'helmet');
 else if(k==='Escape'||k==='p'||k==='P')togglePause();else if((k==='Enter')&&(state==='title'||state==='results'))go();});
addEventListener('keyup',e=>{const k=e.key;if(k==='ArrowLeft'||k==='a'||k==='A')input.keyL=0;else if(k==='ArrowRight'||k==='d'||k==='D')input.keyR=0;else if(k==='ArrowDown'||k==='s'||k==='S'){input.brakeHeld=false;input.brakeAir=false;}else if(k===' '||k==='ArrowUp'||k==='w'||k==='W')hopUp();});
function hopDown(){if(state!=='ride')return;input.hopHeld=true;input.hopAir=!P.ground;input.hopT=0;$('hop').classList.add('on');}
function hopUp(){if(!input.hopHeld)return;input.hopHeld=false;input.hopAir=false;$('hop').classList.remove('on');if(state==='ride'&&P.ground){input.hopCharge=clamp(input.hopT/.35,0,1);input.hop=true;}}
$('viewBtn').addEventListener('click',()=>setView(view==='helmet'?'chase':'helmet'));
// steering sensitivity 1 (calm) … 5 (twitchy): thumb travel, response curve, input smoothing, lean spring
const SENS_T=[{r:.30,e:2.0,d:5,k:45,c:12.7},{r:.24,e:1.8,d:6.5,k:55,c:14},{r:.19,e:1.6,d:8,k:70,c:15.9},{r:.15,e:1.4,d:10,k:85,c:17.5},{r:.12,e:1.25,d:12,k:95,c:18.5}];
let sens=clamp(+(store.get('sens')||2),1,5);const SENS=()=>SENS_T[sens-1];
const SENS_NAMES=['Calm','Smooth','Medium','Quick','Twitchy'];
const syncSens=v=>{sens=v;store.set('sens',v);for(const id of['sens','sens2']){$(id).value=v;$(id+'Val').textContent=SENS_NAMES[v-1];}};
$('sens').addEventListener('input',e=>syncSens(+e.target.value));$('sens2').addEventListener('input',e=>syncSens(+e.target.value));syncSens(sens);

// ───────────────────────── tilt control: the phone is the handlebar.
// Roll it like a steering wheel to lean the bike left/right; tip the top edge away from you to lean forward
// (tuck and pump on the ground, nose down in the air) or toward you to lean back (brake on the ground, nose up
// in the air). Both axes come from the world-up vector in screen coordinates (x right, y up, z out of the screen),
// which works however steeply the phone is held. The native iPhone shell supplies that vector from Core Motion;
// a browser gets it from deviceorientation. The position you hold during the countdown is centre.
// The viewer may not pass motion sensors to the page; if no reading arrives we say so and switch it back off.
const NATIVE=window.RLNative||null;
const tilt={on:false,val:0,fwd:0,got:false,cal:true,r0:0,p0:0};
function note(msg,ms=5000){const n=$('note');n.textContent=msg;n.hidden=false;clearTimeout(note.t);note.t=setTimeout(()=>n.hidden=true,ms);}
const D2R=Math.PI/180;
function tiltFromUp(x,y,z){tilt.got=true;
 const r=Math.atan2(-x,Math.hypot(y,z))/D2R,p=Math.atan2(z,y)/D2R;   // roll (+ = right side down), pitch (+ = top edge away)
 if(tilt.cal){tilt.r0=r;tilt.p0=p;}
 const S=SENS();let d=r-tilt.r0;if(Math.abs(d)<2)d=0;else d-=Math.sign(d)*2;const full=lerp(30,16,(sens-1)/4);const xr=clamp(d/full,-1,1);
 tilt.val=Math.sign(xr)*Math.pow(Math.abs(xr),S.e*.75);
 let f=((p-tilt.p0+540)%360)-180;if(Math.abs(f)<4)f=0;else f-=Math.sign(f)*4;const xf=clamp(f/20,-1,1);tilt.fwd=Math.sign(xf)*Math.pow(Math.abs(xf),1.3);}
// the screen's rotation from the phone's portrait orientation, counter-clockwise in degrees (Apple's window.orientation)
function screenAngle(){const a=typeof window.orientation==='number'?window.orientation:(screen.orientation&&screen.orientation.angle)||0;return ((a%360)+360)%360;}
function onOrient(e){if(e.beta==null||e.gamma==null)return;const b=e.beta*D2R,g=e.gamma*D2R;
 // world-up in portrait device coordinates (x right, y up, z out of the screen), from the W3C Euler angles R = Rz(α)Rx(β)Ry(γ)
 const ux=-Math.cos(b)*Math.sin(g),uy=Math.sin(b),uz=Math.cos(b)*Math.cos(g);
 // into screen coordinates: screen right = device (cos a, −sin a), screen up = device (sin a, cos a)
 const a=screenAngle()*D2R,c=Math.cos(a),s=Math.sin(a);tiltFromUp(ux*c-uy*s,ux*s+uy*c,uz);}
window.__rlMotion=(x,y,z)=>{if(tilt.on)tiltFromUp(x,y,z);};
async function setTilt(on,quiet){if(on&&!NATIVE){try{const D=window.DeviceOrientationEvent;if(D&&typeof D.requestPermission==='function'){const r=await D.requestPermission();if(r!=='granted')throw new Error('denied');}}
  catch(e){note('Motion access was refused, so tilt control is off. Drag to steer instead.');on=false;}}
 tilt.on=on;tilt.cal=true;tilt.val=0;tilt.fwd=0;$('steerhint').innerHTML=on?'Tilt to steer<br>tip back to brake':'Drag anywhere<br>to steer';$('tilt').checked=$('tilt2').checked=on;store.set('tilt',on);
 removeEventListener('deviceorientation',onOrient);if(NATIVE)NATIVE.post({t:'motion',on});if(!on)return;
 if(!NATIVE)addEventListener('deviceorientation',onOrient);tilt.got=false;
 setTimeout(()=>{if(tilt.on&&!tilt.got){note('This viewer isn’t passing your phone’s motion sensor to the game, so tilt control can’t work here. Drag to steer instead.',7000);tilt.on=false;$('tilt').checked=$('tilt2').checked=false;removeEventListener('deviceorientation',onOrient);if(NATIVE)NATIVE.post({t:'motion',on:false});}},NATIVE?4000:1800);
 if(!quiet)note('Tilt on: roll the phone to steer, tip it away to pump and tuck, toward you to brake. How you hold it at the countdown is centre.',5000);}
$('tilt').addEventListener('change',e=>setTilt(e.target.checked));$('tilt2').addEventListener('change',e=>setTilt(e.target.checked));
// in the iPhone app the motion sensor needs no permission, so tilt starts on unless you've turned it off
if(NATIVE&&NATIVE.motion&&store.get('tilt')!==false)setTilt(true,true);
const syncHap=v=>{HAP.level=v?1:0;$('hap').checked=$('hap2').checked=v;store.set('hap',v);if(!v)HAP.stop();};
$('hap').addEventListener('change',e=>syncHap(e.target.checked));$('hap2').addEventListener('change',e=>syncHap(e.target.checked));
syncHap(store.get('hap')!==false);
if(HAP.kind==='none'&&!/iP(hone|ad|od)/.test(navigator.userAgent))for(const id of['hap','hap2'])$(id).parentElement.hidden=true;
HAP.armTapTick($('hop'));
let paused=false;
function togglePause(){if(state==='ride'||state==='countdown'||state==='crash'){paused=!paused;if(paused)HAP.stop();else tilt.calT=.35;show(['pause'],paused);if(!paused)last=performance.now();}}
$('pauseBtn').addEventListener('click',togglePause);$('resume').addEventListener('click',togglePause);
$('restart').addEventListener('click',()=>{paused=false;show(['pause','crashmsg'],false);startRun();});
$('toTop').addEventListener('click',()=>{paused=false;show(['pause','crashmsg'],false);startRun('free');});
$('toTitle').addEventListener('click',()=>{paused=false;show(['pause','crashmsg','hud-time','hud-speed','minimap','nav','pauseBtn','viewBtn','hop','brake','steerhint'],false);placeRider(START.x,START.z-1,0);state='title';show(['title'],true);});
$('sound').addEventListener('click',()=>{SFX.on=!SFX.on;$('sound').textContent='Sound: '+(SFX.on?'on':'off');});
const syncAssist=v=>{assist=v;$('assist').checked=$('assist2').checked=v;store.set('assist',v);};
$('assist').addEventListener('change',e=>syncAssist(e.target.checked));$('assist2').addEventListener('change',e=>syncAssist(e.target.checked));
{const a=store.get('assist');if(a===false)syncAssist(false);}
function go(m){try{if(navigator.audioSession)navigator.audioSession.type='playback';}catch(_){}SFX.init();SFX.resume();startRun(m);}
$('goRace').addEventListener('click',()=>go('race'));$('goFree').addEventListener('click',()=>go('free'));$('goSkinny').addEventListener('click',()=>go('skinny'));$('again').addEventListener('click',()=>go(mode));
$('resTitle').addEventListener('click',()=>{show(['results'],false);placeRider(START.x,START.z-1,0);state='title';show(['title'],true);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)SFX.resume();if(document.hidden&&(state==='ride'||state==='countdown')&&!paused)togglePause();});
if(isMobile)document.querySelector('.kb').hidden=true;

// ───────────────────────── loop
let last=performance.now(),acc=0,hudT=0,ftAvg=16,qT=0,tileT=0;
function frame(now){requestAnimationFrame(frame);
 let rdt=Math.min(.05,(now-last)/1000);last=now;if(paused){return;}
 ftAvg=lerp(ftAvg,rdt*1000,.05);
 qT+=rdt;if(qT>2.5&&state!=='loading'){qT=0;const q=getQuality();if(ftAvg>24&&q>.55)setQuality(Math.max(.55,q*.85));else if(ftAvg<14.5&&q<1)setQuality(Math.min(1,q*1.1));}
 timeScale=damp(timeScale,1,state==='crash'?1.2:4,rdt);const dt=rdt*timeScale;
 // tilt: centre is wherever the phone is held during the countdown; leaning back brakes (on the ground)
 tilt.calT=Math.max(0,(tilt.calT||0)-rdt);tilt.cal=tilt.on&&((state!=='ride'&&state!=='finish')||tilt.calT>0);input.lean=tilt.on&&state==='ride'?tilt.fwd:0;
 input.btnBrake=input.brakeHeld?Math.min(1,(input.btnBrake||0)+rdt*4):0;input.brake=Math.max(input.btnBrake,P.ground?clamp(-input.lean*1.15,0,1):0);
 input.steer=damp(input.steer,clamp((steerId!==null||!tilt.on?input.steerT:tilt.val)+(input.keyR-input.keyL)*.8,-1,1),SENS().d,rdt);
 if(state==='countdown'){cdT-=rdt;const n=Math.ceil(cdT-.2);const el=$('count');el.hidden=false;
  if(cdT>.2){if(el.textContent!==String(n)){el.textContent=n;el.classList.remove('go');SFX.tone(660,.18,.2,'square');fx('count',0);}}
  else if(el.textContent!=='GO'){el.textContent='GO';el.classList.add('go');SFX.tone(1320,.4,.22,'square');fx('count',1);}
  if(cdT<=0){state='ride';el.hidden=true;}}
 if(state==='ride'||state==='countdown'||state==='finish'||state==='crash'){
  if((state==='ride'||state==='crash')&&mode==='race')runT+=dt;else if(state==='ride')runT+=dt;
  if(state!=='crash'&&state!=='countdown'){acc+=dt;const h=1/120;const x0=P.x,z0=P.z;while(acc>=h){step(h);acc-=h;if(state==='crash')break;}if(state==='ride')P.dist+=Math.hypot(P.x-x0,P.z-z0);}
  if(state==='countdown'){P.y=surf(P.x,P.z);}
 }
 if(state==='crash'){crashT+=rdt;updateCrashBodies(dt);
  if(crashT>2.4&&mode==='skinny'&&SK.onSec>=0){show(['crashmsg'],false);const st=STRUCTS[CORE.BALANCE.sections[Math.max(0,SK.onSec)]],q=st.pts[1];placeRider(q.x,q.z,Math.atan2(-q.tx,-q.tz),q.y);P.vx=q.tx*2;P.vz=q.tz*2;state='ride';SK.offT=0;}
  else if(crashT>2.4){show(['crashmsg'],false);const c=respawnPoint();
   placeRider(c.x,c.z,c.th,c.y);const v=6;P.vx=-Math.sin(P.th)*v;P.vz=-Math.cos(P.th)*v;state='ride';bike.position.set(P.x,P.y,P.z);
   camera.position.set(P.x+Math.sin(P.th)*5,P.y+2.2,P.z+Math.cos(P.th)*5);}}
 checkProgress();
 if(state==='ride'||state==='finish')topSpd=Math.max(topSpd,P.spd);
 updateBikeVisual(rdt);feelFrame(rdt);passFrame(rdt);
 present(rdt,now);}
// gates & finish
function checkProgress(){
 if(mode==='skinny'&&state==='ride'){const s=balSec();const B=CORE.BALANCE,N=B.sections.length;
  if(s>=0){SK.onSec=s;SK.offT=0;if(s>SK.sec){SK.sec=s;if(s>0)SFX.tone(740+s*30,.12,.12);}}
  else if(SK.onSec>=0&&P.ground){
   if(SK.onSec===N-1){if(!SK.done){SK.done=true;state='finish';fx('finish');finishRun();}return;}
   // came off the woodwork before the end: a dab. Back to the start of that section after a moment.
   SK.offT+=1/60;if(SK.offT>.05&&SK.offT<.07){SK.dabs++;if(DEV.log)DEV.log.push({sec:SK.onSec,lat:+(P.lastLat||0).toFixed(2),v:+Math.hypot(P.vx,P.vz).toFixed(1),air:!P.ground});pop('Dab','bad','+3 s');runT+=3;fx('dab');}
   if(SK.offT>.9){const st=STRUCTS[B.sections[SK.onSec]],q=st.pts[Math.min(1,st.pts.length-1)];placeRider(q.x,q.z,Math.atan2(-q.tx,-q.tz),q.y);P.vx=q.tx*2;P.vz=q.tz*2;SK.offT=0;}}
  return;}
 // a gate you've ridden more than 25 m below without going through is missed: +5 s, carry on to the next
 if(state==='ride'&&mode==='race'&&gateIdx<GATES.length&&P.z<GATES[gateIdx].z-25){runT+=5;splits.push(runT);pop('Missed gate','bad','+5 s');SFX.tone(220,.35,.2,'square');fx('miss');gateIdx++;styleGates();}
 if(state==='ride'){const t=target();
  if(mode==='race'&&t&&Math.hypot(P.x-t.x,P.z-t.z)<t.r+1.5){
   if(gateIdx<GATES.length){splits.push(runT);const b=bestSplits[gateIdx];$('spName').textContent='Gate '+(gateIdx+1)+' of '+GATES.length;$('spTime').textContent=fmt(runT);
    const dl=$('spDelta');if(b){const d=runT-b;dl.textContent=(d<0?'−':'+')+Math.abs(d).toFixed(2);dl.style.background=d<0?'var(--moss)':'var(--slow)';dl.hidden=false;}else dl.hidden=true;
    $('split').classList.add('on');setTimeout(()=>$('split').classList.remove('on'),2200);fx('gate');gateIdx++;styleGates();}
   else{state='finish';fx('finish');finishRun();}}
  if(mode==='free'&&Math.hypot(P.x-FINISH.x,P.z-FINISH.z)<FINISH.r+4){state='finish';fx('finish');finishRun();}}}
// effects, camera, streaming, HUD and the render itself
function present(rdt,now){
 // effects: dust from dirt, a little from grass
 if(P.ground&&(state==='ride'||state==='finish')&&P.spd>2){
  const F={x:-Math.sin(P.th),z:-Math.cos(P.th)};const rx=P.x-F.x*.63,rz=P.z-F.z*.63;const dirt=SW[0]+SW[3]*.4;
  const rate=((.15+dirt*.6)+P.skid*2.4*dirt+input.brake*1.5*dirt)*Math.min(1,P.spd/14);const n=Math.random()<rate*rdt*60?1+(P.skid>.3?2:0):0;
  for(let i=0;i<n;i++)dust.spawn(rx+(Math.random()-.5)*.3,P.y+.08,rz+(Math.random()-.5)*.3,-P.vx*.12+(Math.random()-.5)*1.4,.4+Math.random()*.9,-P.vz*.12+(Math.random()-.5)*1.4,1.2+Math.random()*1.2,.45+Math.random()*.5,(.12+dirt*.18)+P.skid*.3);
  if(dirt>.4&&P.skid>.35&&Math.random()<.6)debris.spawn(rx,P.y+.1,rz,(Math.random()-.5)*3,1+Math.random()*2.5,(Math.random()-.5)*3,.7,.12,1);}
 dust.update(rdt*timeScale,3.2,.18,1.6);debris.update(rdt*timeScale,0,-9,.3);
 for(const f of flags){f.rotation.y=Math.sin(now/300+f.position.x)*.25;}
 updateCamera(rdt);
 tileT+=rdt;if(tileT>.1&&!loading){tileT=0;updateTiles(state==='ride'?4:8);}
 STRUCT.updateStructures&&STRUCT.updateStructures(rdt,now,camera);
 updateWorld(rdt,now,bike.position,P.spd,{firstPerson:view==='helmet'&&state!=='crash'});updateFlora(rdt,now,camera,bike.position);
 SFX.update({spd:P.spd,live:state==='ride'||state==='finish',ground:P.ground,air:P.air,surf:SW,wood:!!P.deck,narrow:!!(P.deck&&P.deck.w<.75),rough:P.rough,skid:P.skid,brake:input.brake,
  coast:!P.pedal,pedal:!!P.pedal,wheelHz:Math.hypot(P.vx,P.vz)/(2*Math.PI*.39),suspV:(P.sFV+P.sRV)*1.1,lean:P.lean,helmet:view==='helmet'&&state!=='crash',pumping:!!P.pumping,dt:rdt});
 hudT+=rdt;if(hudT>.066&&state!=='title'&&state!=='loading'){hudT=0;$('tTime').textContent=mode==='free'?String(style):fmt(runT);if(mode==='skinny')$('tPB').textContent='Section '+Math.max(0,SK.sec+1)+'/'+CORE.BALANCE.sections.length+' · '+SK.dabs+' dab'+(SK.dabs===1?'':'s');$('tSpd').textContent=Math.round(P.spd*3.6);drawMinimap();if(mode==='race')drawNav();}
 renderWorld(rdt);
}
function finishRun(){const t=runT;let isPB=false;
 if(mode==='skinny'){const b=store.get(SK.bestKey());isPB=!b||t<b;if(isPB)store.set(SK.bestKey(),t);
  setTimeout(()=>{$('rHead').textContent='Skinnies · '+mtn().name;$('rTime').textContent=fmt(t);$('rBestL').textContent='Best';$('rBest').textContent=fmt(store.get(SK.bestKey()));
   $('rTop').textContent=Math.round(topSpd*3.6)+' km/h';$('rAir').textContent=airTotal.toFixed(1)+' s';$('rStyleL').textContent='Dabs';$('rStyle').textContent=SK.dabs;$('rCrash').textContent=crashes;$('rPB').hidden=!isPB;$('again').textContent='Try again';
   show(['hop','brake','steerhint','pauseBtn','viewBtn','hud-time','hud-speed','minimap','nav','crashmsg'],false);show(['results'],true);},1200);return;}
 if(mode==='race'){isPB=!best||t<best;if(isPB){best=t;store.set('best_'+mtn().id,t);bestSplits=splits.slice();store.set('splits_'+mtn().id,bestSplits);}}
 setTimeout(()=>{$('rHead').textContent=mode==='race'?'Finish · Gate race':'Valley floor · Freeride';
  $('rTime').textContent=mode==='race'?fmt(t):style+' pts';$('rBestL').textContent=mode==='race'?'Best':'Distance';$('rBest').textContent=mode==='race'?fmt(best):(P.dist/1000).toFixed(2)+' km';
  $('rTop').textContent=Math.round(topSpd*3.6)+' km/h';$('rAir').textContent=airTotal.toFixed(1)+' s';
  $('rStyle').textContent=mode==='race'?style:fmt(t);$('rStyleL').textContent=mode==='race'?'Style':'Ride time';$('rCrash').textContent=crashes;$('rPB').hidden=!isPB;
  $('again').textContent=mode==='race'?'Race again':'Back to the top';
  show(['hop','brake','steerhint','pauseBtn','viewBtn','hud-time','hud-speed','minimap','nav','crashmsg'],false);show(['results'],true);$('fBest').textContent=fmt(best);},1400);}

// ───────────────────────── loading a mountain
let structObj=null,loading=false;
function titleFacts(){const m=mtn();$('mName').innerHTML=m.name.length>8?m.name:m.name.slice(0,Math.ceil(m.name.length/2))+'<span>'+m.name.slice(Math.ceil(m.name.length/2))+'</span>';$('mSub').textContent=m.sub;
 $('fFeat').textContent=(CORE.TRAILS.length?CORE.TRAILS.length+' trails · ':'')+featureList(X_MIN,Z_MIN,X_MAX,Z_MAX).length+(STRUCTS.length?' + '+STRUCTS.length+' wood':'');
 $('fDrop').textContent='−'+Math.round(heightAt(START.x,START.z)-heightAt(FINISH.x,FINISH.z))+' m';$('fBest').textContent=fmt(best);
 document.querySelectorAll('.mtn').forEach(b=>b.setAttribute('aria-pressed',b.dataset.id===m.id?'true':'false'));}
async function loadMountain(id){loading=true;state='loading';show(['title'],false);show(['loading'],true);
 const tick=()=>new Promise(r=>requestAnimationFrame(()=>r()));const bar=v=>{$('loadBar').style.width=Math.round(v*100)+'%';};bar(0);
 // forget the old mountain: tiles, forest, woodwork, gates
 tileGen++;for(const t of tileList){if(t.obj){scene.remove(t.obj);disposeTerrainTile(t.obj);t.obj=null;}if(t.flora&&t.flora.group)scene.remove(t.flora.group);t.flora=null;t.floraBusy=false;t.busy=false;t.lod=-1;}busyCount=0;
 $('loadTxt').textContent='Shaping '+(MOUNTAINS.find(m=>m.id===id)||MOUNTAINS[0]).name+'…';await tick();
 setMountain(id);store.set('mtn',mtn().id);
 try{await Promise.all([TERRAIN.setMountain?TERRAIN.setMountain(mtn().id):null,FLORA.setMountain?FLORA.setMountain(mtn().id):null]);}catch(e){console.error(e);}
 if(structObj){scene.remove(structObj);STRUCT.disposeStructures(structObj);}structObj=STRUCT.buildStructures();scene.add(structObj);buildPostColliders();
 buildCourse();best=store.get('best_'+mtn().id);bestSplits=store.get('splits_'+mtn().id)||[];courseIdx=0;
 placeRider(START.x,START.z-1,0);styleGates();camera.position.set(P.x+5,P.y+2,P.z+5);camera.lookAt(P.x,P.y+1,P.z);
 $('loadTxt').textContent='Raising the mountain…';
 let k=0;const far=tileList.slice().sort((a,b)=>Math.hypot(a.cx-P.x,a.cz-P.z)-Math.hypot(b.cx-P.x,b.cz-P.z));
 for(const t of far){if(!t.obj&&!t.busy)requestTerrain(t,3);if(++k%60===0){bar(.35*k/far.length);await tick();}}
 $('loadTxt').textContent='Planting the forest…';
 for(let pass=0;pass<400;pass++){updateTiles(40);const pend=tileList.filter(t=>(t.d<LOD_D[0]&&t.lod!==0)||t.busy||(t.d<Math.min(FLORA_D,400)&&!t.flora)).length;bar(.35+.45*(1-Math.min(1,pend/60)));if(!pend)break;await tick();}
 $('loadTxt').textContent='Drawing the map…';
 await buildMap(v=>bar(.8+.2*v));
 updateBikeVisual(.016);try{await terrainReady;await floraReady;}catch(_){}renderer.compile(scene,camera);
 titleFacts();state='title';loading=false;show(['loading'],false);show(['title'],true);}
document.querySelectorAll('.mtn').forEach(b=>b.addEventListener('click',()=>{if(loading||b.dataset.id===mtn().id)return;loadMountain(b.dataset.id);}));
async function boot(){resize();setView(view);mode=store.get('mode')==='free'?'free':'race';
 await loadMountain(store.get('mtn')||'ridgeline');requestAnimationFrame(frame);}
// Dev hook for automated tests: open with #dev
if(location.hash==='#dev')window.__rl={DEV,tilt,HAP,SK,CORE,loadMountain,surf,get deck(){return P.deck},checkProgress,respawnPoint,get crashesN(){return crashes},get runT(){return runT},tiles,tileList,updateTiles,placeRider,startRun,target,eye,setView,crash,camS,bike,rider,camera,P,step,input,heightAt,scene,get gateIdx(){return gateIdx},get mode(){return mode},get state(){return state},set state(v){state=v}};
boot();
