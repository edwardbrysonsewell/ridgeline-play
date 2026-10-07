// flora_worker.js — deterministic tile contents for every mountain. Pure JS (no three.js):
// runs as a module Web Worker, and flora.js also imports it directly as a fallback.
//   genTile(i,j)          trees, props (boulders/logs/stumps) and colliders for one 64 m tile
//   genGround(i,j,mobile) ground cover (grass, flowers, ferns, shrubs, saplings, small rocks), bucketed in 16 m cells
// Biomes: ridgeline (spruce/fir/pine/aspen + meadows), widowmaker (alpine larch, krummholz, scree under cliffs),
// shoreline (old-growth cedar / Douglas fir / hemlock rainforest, sword ferns, salal, nurse logs),
// highland (Hollowfell: tall dark spruce/fir/pine timber, bracken, bilberry, heather on the open moor, very few rocks),
// alpine (Razorback: Widowmaker's species — open tundra and granite up high, larch and fir forest from ~500 m down; no
// boulder fields: a few boulders, mostly in clusters under the cliffs, none within ~10 m of a trail).
import {MOUNTAIN,setMountain,TILE,heightAt,forestAt,aspenAt,rockZone,clearAt,padClear,trailAt,TRAILS,surfaceInto,featureList,noise2,fbm,rng,hash2,clamp,lerp,smooth} from './terrainfn.js';

// species sets per mountain: the index is what tile data stores (keep in sync with SPECIES in flora.js)
export const SETS={
 ridgeline:['spruceA','spruceB','fir','pine','snag','aspenA','aspenB'],
 widowmaker:['larch','larchB','krumm','stuntFir','whitebark','snagAlp'],
 shoreline:['cedar','doug','hemlock','snagRain'],
 desert:['juniper','pinyon','juniperDead']};
SETS.alpine=SETS.widowmaker;
SETS.highland=['spruceA','spruceB','fir','pine','snag'];   // Hollowfell: tall, dark conifers (no aspen)   // Razorback: the same high-alpine species, far sparser (see ALP below)
// trunk radius at ~0.5 m (m, before instance scale) for colliders, and the base radius used for corridor clearance
const TRUNK={spruceA:.3,spruceB:.34,fir:.23,pine:.25,snag:.27,aspenA:.17,aspenB:.17,
 larch:.27,larchB:.25,krumm:.16,stuntFir:.16,whitebark:.3,snagAlp:.25,cedar:1.38,doug:1.15,hemlock:.74,snagRain:.9,juniper:.22,pinyon:.24,juniperDead:.2};
// "Less trees" (the author, 2026-10-06): every forest is thinned to KEEP of its old density and broken by open glades
// ~80 m across (20 % of the trees left inside them), and trees stand ≥ 1.5 m further back from every riding line (none within ~6 m of a race line). The
// trees that remain are a subset of the old ones, at the same spots, so each mountain's forest keeps its character.
const KEEP={ridgeline:.3,freefall:.24,widowmaker:.33,shoreline:.35,rampage:1,razorback:.3,hollowfell:.3},TREE_LINE_CLR=1.5;   // 10-06: Bryson "WAY too many trees" → about a third
export const PROP_KEYS=['rockA','rockB','rockC','log','logOld','stump','logMoss','stumpMoss'];
export const GROUND_KEYS=['grass','meadow','flowersA','flowersB','fern','bush','sapFir','sapSpruce','pebble'];
export const KIND=['tree','rock','log'];
export const T_STRIDE=10,P_STRIDE=12,G_STRIDE=9,SUB=4;   // SUB×SUB ground buckets per tile (16 m)
const seedOf=(i,j,k)=>(Math.floor(hash2(i,j,k)*2147483647)|0)+k*7919;

// feature footprints (run-in, ramp, landing) must stay clear
function featTest(x0,z0,x1,z1){const fs=featureList(x0-70,z0-70,x1+70,z1+70);
 return (x,z,pad)=>{for(const f of fs){const px=x-f.x,pz=z-f.z,u=px*f.ux+pz*f.uz;if(u<-8-pad||u>f.len+25+pad)continue;const v=-px*f.uz+pz*f.ux;if(Math.abs(v)<5+pad)return true;}return false;};}
// clear of pads, woodwork and singletrack corridors over a whole footprint of radius rad
function clearRing(x,z,rad){if(clearAt(x,z)>0)return false;if(rad<=0)return true;
 for(let k=0;k<6;k++){const a=k*1.0472;if(clearAt(x+Math.cos(a)*rad,z+Math.sin(a)*rad)>0)return false;}return true;}
const slopeAt=(x,z)=>{const hx=heightAt(x+1,z)-heightAt(x-1,z),hz=heightAt(x,z+1)-heightAt(x,z-1);return Math.hypot(hx,hz)/2;};
// below a cliff: the ground rises steeply within the next 12 m uphill (+z)
const underCliff=(x,z,y)=>heightAt(x,z+12)-y>6.5;

export function genTile(i,j){
 const BIO=MOUNTAIN.biome||MOUNTAIN.id,ALP=BIO==='alpine',HL=BIO==='highland',M=ALP?'widowmaker':BIO,x0=i*TILE,z0=j*TILE,inFeat=featTest(x0,z0,x0+TILE,z0+TILE),set=SETS[M]||SETS.ridgeline;
 const trees=[],props=[],col=[];
 // ── trees: jittered grid, accepted by forest density (edges + small glades); corridors and features kept open
 {const r=rng(seedOf(i,j,1)),N=M==='shoreline'?10:13,cs=TILE/N;
  for(let a=0;a<N;a++)for(let b=0;b<N;b++){const x=x0+(b+.1+.8*r())*cs,z=z0+(a+.1+.8*r())*cs;const u1=r(),u2=r(),u3=r(),u4=r(),u5=r(),u6=r(),u7=r(),u8=r();
   const f=forestAt(x,z),s=-z;let p,sp,sc;
   if(M==='shoreline'){p=smooth(.02,.35,f)*.93+(f<.02?.03:0);}
   else if(M==='desert'){p=.006+.03*smooth(-.1,.5,noise2(x*.013+5,z*.013-2));}
   else if(HL){const glade=smooth(-.38,.12,noise2(x*.031+3.3,z*.031-1.1));p=smooth(.03,.45,f)*(.32+.68*glade)*.36;}
   else if(ALP){const glade=smooth(-.38,.12,noise2(x*.031+3.3,z*.031-1.1));p=smooth(.03,.5,f)*(.3+.7*glade)*.5+.006*(1-rockZone(x,z))*smooth(400,1100,s);}
   else if(M==='widowmaker'){const glade=smooth(-.38,.12,noise2(x*.031+3.3,z*.031-1.1));p=smooth(.03,.5,f)*(.35+.65*glade)*.85+.022*(1-rockZone(x,z))*smooth(250,700,s);}
   else{const glade=smooth(-.38,.12,noise2(x*.031+3.3,z*.031-1.1));p=smooth(.03,.5,f)*(.28+.72*glade)*.95+(f<.03?.004:0);}
   {const og=smooth(-.18,.22,noise2(x*.0115+17.3,z*.0115+4.1));p*=(KEEP[MOUNTAIN.id]??.9)*(.2+.8*og);}   // thinned, with glades
   if(u1>p)continue;
   // species and size
   if(M==='shoreline'){sp=u3<.07?3:u3<.42?0:u3<.72?1:2;sc=u4<.3?.42+u5*.3:.78+u5*.45;}
   else if(M==='desert'){sp=u3<.22?2:u3<.62?0:1;sc=.55+u5*.6;}
   else if(HL){sp=u3<.05?4:u3<.2?3:u3<.45?2:(u6<.55?0:1);sc=(u4<.12?.45+u5*.25:.85+u5*.55)*lerp(.8,1.12,smooth(900,1700,s));}   // tall timber
   else if(M==='widowmaker'){const rk=rockZone(x,z),hi=1-smooth(300,1400,s);
    sp=u3<.06?5:u3<.06+.18+.25*rk+.15*hi?2:u3<.55?(u6<.6?0:1):u3<.78?3:4;
    sc=sp===2?.7+u5*.6:u4<.2?.45+u5*.25:.75+u5*.45;if(ALP)sc*=lerp(.6,.95,smooth(1200,2400,s));}
   else{const asp=u2<aspenAt(x,z)*.92;
    if(asp){sp=u3<.55?5:6;sc=u4<.18?.5+u5*.25:.82+u5*.4;}
    else{const pineP=clamp(.12+.38*smooth(700,2500,s)+.25*(1-f),.1,.65);sp=u3<.05?4:u3<.05+pineP?3:u3<.05+pineP+.24?2:(u6<.55?0:1);sc=u4<.15?.3+u5*.25:.72+u5*.55;}
    sc*=lerp(.62,1,smooth(150,520,s));}
   const key=set[sp],tr=TRUNK[key]*sc;
   if(!clearRing(x,z,tr+(M==='shoreline'?1.2:.4)+TREE_LINE_CLR)||inFeat(x,z,1.5+tr))continue;
   if(M!=='ridgeline'&&slopeAt(x,z)>(M==='widowmaker'?.95:M==='desert'?.7:1.3))continue;          // nothing on cliff faces
   const y=heightAt(x,z);
   let c;
   if(M==='desert')c=sp===2?[.95+u7*.15,.93+u7*.15,.9+u8*.15]:[.8+u7*.25,.85+u8*.2,.75+u6*.2];
   else if(HL)c=sp===4?[.8+u7*.2,.8+u7*.2,.78+u8*.2]:[.62+u7*.25,.76+u8*.22,.68+u6*.2];   // dark, wet greens
   else if(M==='shoreline')c=sp===3?[.8+u7*.2,.82+u7*.2,.78+u8*.2]:[.72+u7*.35,.8+u8*.3,.72+u6*.3];
   else if(M==='widowmaker')c=sp===0||sp===1?[.85+u7*.3,.8+u8*.35,.75+u6*.3]:[.75+u7*.35,.82+u8*.3,.8+u6*.3];
   else c=sp>=5?[.9+u7*.25,.85+u8*.25,.8+u6*.2]:sp===4?[.85+u7*.2,.85+u7*.2,.85+u8*.2]:[.78+u7*.4,.84+u8*.32,.8+u6*.3];
   trees.push(x,y-.12*sc,z,u6*6.283,sc,sp,c[0],c[1],c[2],0);
   col.push(x,z,tr+.15,0);}}
 // ── boulders: rock zones (and scree under cliff bands on Widowmaker), a few erratics elsewhere
 {const r=rng(seedOf(i,j,2)),N=8,cs=TILE/N;
  for(let a=0;a<N;a++)for(let b=0;b<N;b++){const x=x0+(b+.1+.8*r())*cs,z=z0+(a+.1+.8*r())*cs;const u1=r(),u2=r(),u3=r(),u4=r(),u5=r(),u6=r();
   // Widowmaker and Rampage (2026-10-06): boulder fields thinned to ~a quarter, clusters kept under the cliffs, ≥ ~6 m
   // clear of every riding line; their cliffs, faces and terraces (the terrain itself) are untouched
   const rk=rockZone(x,z);let p=M==='shoreline'?rk*.3+.01:HL?rk*.15+.003:ALP?rk*.15+.002:M==='widowmaker'?rk*.17+.006:M==='desert'?.022:rk*.42+.012;let big=M==='widowmaker'?1.4:M==='desert'?1.25:1;
   let y=null;if((M==='widowmaker'||M==='desert')&&u1>=p){y=heightAt(x,z);if(underCliff(x,z,y)){p+=ALP?.12:.2;big=1.2;}}
   if(u1>p)continue;const sc=(.7+u2*u2*2.3)*(rk>.3?1:.75)*big;
   if(!clearRing(x,z,sc*1.2+(ALP||HL?8:M==='widowmaker'||M==='desert'?5:0))||inFeat(x,z,sc*1.3))continue;if((M==='widowmaker'||M==='desert')&&slopeAt(x,z)>1.1)continue;   // Razorback: ~10 m clear of every trail
   if(y===null)y=heightAt(x,z);const t=.85+u4*.3;const moss=M==='shoreline',sand=M==='desert';
   props.push(x,y-sc*.22,z,(u5-.5)*.3,u3*6.283,(u6-.5)*.3,sc,Math.floor(u3*2.999),moss?t*.8:sand?t*(1.3+u5*.15):t,moss?t*.92:sand?t*(.78+u6*.1):t*(.97+u5*.05),moss?t*.72:sand?t*.58:t*(.93+u6*.06),0);
   col.push(x,z,sc*1.05,1);
   for(let k=0;k<(ALP||HL?1:2);k++){const v1=r(),v2=r(),v3=r();if(v1<.45)continue;const a2=v2*6.283,dd=sc*(1.4+v3*.8),xx=x+Math.cos(a2)*dd,zz=z+Math.sin(a2)*dd;const s2=sc*(.22+v3*.25);
    if(!clearRing(xx,zz,s2+(M==='widowmaker'||M==='desert'?5:0))||inFeat(xx,zz,s2))continue;props.push(xx,heightAt(xx,zz)-s2*.22,zz,0,v2*6.283,0,s2,(k+1)%3,M==='desert'?t*1.3:t,M==='desert'?t*.8:t,M==='desert'?t*.6:t,0);if(s2>.45)col.push(xx,zz,s2*1.05,1);}}}
 // ── fallen logs and stumps on the forest floor (nurse logs and giant mossy stumps on Shoreline)
 {const r=rng(seedOf(i,j,3)),N=3,cs=TILE/N,shore=M==='shoreline';
  for(let a=0;a<N;a++)for(let b=0;b<N;b++){const x=x0+(b+.15+.7*r())*cs,z=z0+(a+.15+.7*r())*cs;const u1=r(),u2=r(),u3=r(),u4=r(),u5=r();
   const f=forestAt(x,z);if(u1>f*(shore?.75:.6))continue;const sc=shore?1.05+u2*.65:.7+u2*.45,len=7*sc,yaw=u3*6.283,rad=.36*sc;
   const pts=[-.5,-.25,0,.25,.5].map(t=>[x+Math.cos(yaw)*len*t,z-Math.sin(yaw)*len*t]);
   if(pts.some(q=>!clearRing(q[0],q[1],rad+.6)||inFeat(q[0],q[1],1+rad)))continue;
   const h1=heightAt(pts[0][0],pts[0][1]),h2=heightAt(pts[4][0],pts[4][1]);if(Math.abs(h1-h2)>len*.45)continue;
   const kind=shore?6:u4<.5?3:4,tc=shore?[.85+u5*.2,.95+u5*.15,.8+u5*.15]:[.9+u5*.2,.9+u5*.2,.9+u5*.2];
   props.push(x,(h1+h2)/2+.12*sc,z,0,yaw,Math.atan2(h1-h2,len),sc,kind,tc[0],tc[1],tc[2],1);
   for(const t of[-.4,0,.4])col.push(x+Math.cos(yaw)*len*t,z-Math.sin(yaw)*len*t,rad+.12,2);}
  for(let k=0;k<(shore?8:10);k++){const x=x0+r()*TILE,z=z0+r()*TILE,u1=r(),u2=r(),u3=r();const f=forestAt(x,z);if(u1>f*(shore?.6:.45))continue;
   const sc=shore?1.4+u2*.9:.7+u2*.6,rr=(shore?.46:.42)*sc;if(!clearRing(x,z,rr+.5)||inFeat(x,z,1+rr))continue;
   props.push(x,heightAt(x,z)-.05,z,0,u3*6.283,0,sc,shore?7:5,.9+u3*.2,.9+u3*.2,.9+u3*.2,0);col.push(x,z,rr,1);}}
 return {trees:new Float32Array(trees),props:new Float32Array(props),col:new Float32Array(col)};}

// ── ground cover. Heights come from a 2 m grid (bilinear), surface weights from a 4 m grid.
export function genGround(i,j,mobile){
 const BIO=MOUNTAIN.biome||MOUNTAIN.id,ALP=BIO==='alpine',HL=BIO==='highland',M=ALP?'widowmaker':BIO,x0=i*TILE,z0=j*TILE,NH=33,HS=2,NS=17,SS=4;
 const H=new Float32Array(NH*NH);for(let a=0;a<NH;a++)for(let b=0;b<NH;b++)H[a*NH+b]=heightAt(x0+b*HS,z0+a*HS);
 const hAt=(x,z)=>{const fx=clamp((x-x0)/HS,0,NH-1.001),fz=clamp((z-z0)/HS,0,NH-1.001),b=Math.floor(fx),a=Math.floor(fz),tx=fx-b,tz=fz-a,k=a*NH+b;
  return lerp(lerp(H[k],H[k+1],tx),lerp(H[k+NH],H[k+NH+1],tx),tz);};
 // slope from the height grid; Widowmaker also needs "below a cliff" (uphill = +z), using heightAt past the tile edge
 const slope=(x,z)=>{const fx=clamp((x-x0)/HS,0,NH-2),fz=clamp((z-z0)/HS,0,NH-2),b=Math.floor(fx),a=Math.floor(fz),k=a*NH+b;return Math.hypot(H[k+1]-H[k],H[k+NH]-H[k])/HS;};
 const W=new Float32Array(NS*NS*6),w=[0,0,0,0];
 for(let a=0;a<NS;a++)for(let b=0;b<NS;b++){const x=x0+b*SS,z=z0+a*SS;const ha=Math.min(a*2,NH-2),hb=Math.min(b*2,NH-2);
  const gx=(H[ha*NH+hb+1]-H[ha*NH+hb])/HS,gz=(H[(ha+1)*NH+hb]-H[ha*NH+hb])/HS;surfaceInto(x,z,1/Math.sqrt(1+gx*gx+gz*gz),w);
  const k=(a*NS+b)*6;W[k]=w[0];W[k+1]=w[1];W[k+2]=w[2];W[k+3]=w[3];W[k+4]=forestAt(x,z);
  W[k+5]=M==='widowmaker'||M==='desert'?(heightAt(x,z+12)-H[ha*NH+hb]>6.5?1:0):0;}
 const wAt=(x,z,c)=>{const fx=clamp((x-x0)/SS,0,NS-1.001),fz=clamp((z-z0)/SS,0,NS-1.001),b=Math.floor(fx),a=Math.floor(fz),tx=fx-b,tz=fz-a,k=(a*NS+b)*6+c;
  return lerp(lerp(W[k],W[k+6],tx),lerp(W[k+NS*6],W[k+NS*6+6],tx),tz);};
 const out=GROUND_KEYS.map(()=>[]),offs=GROUND_KEYS.map(()=>new Int32Array(SUB*SUB+1));
 const r=rng(seedOf(i,j,4)),cell=TILE/SUB,gs=mobile?1.75:1.4;
 // per-mountain densities
 const B=HL?{grass:.9,meadow:.45,flower:.22,fern:.55,bush:.16,sap:.12,peb:.12}:ALP?{grass:.38,meadow:.5,flower:.07,fern:.13,bush:.09,sap:.05,peb:.2}:M==='desert'?{grass:.45,meadow:1,flower:.05,fern:.3,bush:.2,sap:.02,peb:.12}:M==='widowmaker'?{grass:.55,meadow:.65,flower:.1,fern:.2,bush:.12,sap:.08,peb:.3}:M==='shoreline'?{grass:.22,meadow:0,flower:.012,fern:.62,bush:.2,sap:.1,peb:.35}:{grass:1,meadow:.2,flower:.06,fern:.36,bush:.1,sap:.12,peb:.5};
 const steepMax=M==='widowmaker'?1.0:M==='desert'?.8:1.6;const hasTr=TRAILS.length>0;
 for(let ca=0;ca<SUB;ca++)for(let cb=0;cb<SUB;cb++){const cx0=x0+cb*cell,cz0=z0+ca*cell,ci=ca*SUB+cb;
  for(let k=0;k<GROUND_KEYS.length;k++)offs[k][ci]=out[k].length/G_STRIDE;
  const n=Math.round(cell/gs);
  for(let a=0;a<n;a++)for(let b=0;b<n;b++){const x=cx0+(b+r())*cell/n,z=cz0+(a+r())*cell/n;const u1=r(),u2=r(),u3=r(),u4=r(),u5=r();
   const dirt=wAt(x,z,0),gr=wAt(x,z,1),ff=wAt(x,z,2),rk=wAt(x,z,3);if(slope(x,z)>steepMax)continue;const y=hAt(x,z);if(M==='shoreline'&&clearAt(x,z)>.9)continue;
   let shoulder=1;if(hasTr){const tr=trailAt(x,z);if(tr){if(tr.dirt>.2)continue;shoulder=.3+.7*smooth(tr.w+.2,tr.w+1.6,Math.abs(tr.lat));}}if(u5>shoulder)continue;
   const pg=(ALP?lerp(.3,1,smooth(500,1900,-z)):1)*(M==='desert'?(gr*.5+rk*.12+.04)*B.grass*(1-dirt*.6):(gr*1.05+ff*.18-dirt*.6-rk*.5)*B.grass);
   if(u1<pg){const n2=noise2(x*.09,z*.09),dry=clamp(.45+n2*.9-ff*.4+(M==='widowmaker'?.25:0),0,1);const meadow=M==='desert'||ff<.3&&u2<(B.meadow+dry*.5)*(M==='shoreline'?0:1);const sc=(.8+u3*.5)*(M==='widowmaker'?.75:M==='desert'?.7:1);
    if(M==='desert')out[1].push(x,y-.03,z,u4*6.283,sc,sc*(.75+u5*.5),1.05+u5*.15,.9+u5*.1,.62+u5*.1);
    else out[meadow?1:0].push(x,y-.03,z,u4*6.283,sc,sc*(.75+u5*.5),lerp(.62,.86,dry)*(.88+u5*.24),lerp(.8,.78,dry)*(.9+u5*.2),lerp(.5,.48,dry)*(.88+u5*.24));}
   else if(HL&&u1<pg+B.flower*gr*(1-smooth(600,1000,-z))*2.2){out[2].push(x,y-.03,z,u4*6.283,.5+u5*.5,.35+u5*.3,1.05+u3*.15,.7+u5*.12,.9+u3*.15);}   // heather clumps on the moor
   else if(!HL&&u1<pg+B.flower*(M==='desert'?.5:gr)&&u2<.5){const k=u3<.5?2:3;out[k].push(x,y-.02,z,u4*6.283,.8+u5*.5,.8+u5*.5,1,1,1);}}
  // shrubs / ferns / saplings / small rocks
  const m=Math.round(cell/2.6);
  for(let a=0;a<m;a++)for(let b=0;b<m;b++){const x=cx0+(b+r())*cell/m,z=cz0+(a+r())*cell/m;const u1=r(),u2=r(),u3=r(),u4=r(),u5=r();
   const ff=wAt(x,z,2),rk=wAt(x,z,3),dirt=wAt(x,z,0),f=wAt(x,z,4),gr=wAt(x,z,1),cliff=wAt(x,z,5);const y=hAt(x,z);const st=slope(x,z);{let skip=false;const tr=hasTr?trailAt(x,z):null;if(tr){if(tr.dirt>.2||padClear(x,z)>.5)skip=true;else if(Math.abs(tr.lat)<tr.w+1.4&&u5<.6)skip=true;}else if(clearAt(x,z)>.5)skip=true;if(skip)continue;}
   if(st<steepMax){
    const pf=M==='desert'?(.12+rk*.05)*(1-dirt*.5):M==='widowmaker'?(ff*.25+gr*.14+rk*.1)*(1-dirt):ff*B.fern+(M==='shoreline'?.08*(1-dirt):0);
    const pb=M==='desert'?.07*(1-dirt*.5):M==='widowmaker'?f*.12+.02*gr:M==='shoreline'?ff*B.bush:(ff*.1+f*(1-f)*.25)*(1-dirt);
    if(u1<pf){if(M==='desert')out[4].push(x,y-.04,z,u2*6.283,.55+u3*.6,.45+u3*.45,1.35+u4*.15,1.05+u5*.1,1.25+u4*.12);   // sagebrush (silver-grey)
     else if(M==='widowmaker')out[4].push(x,y-.03,z,u2*6.283,.5+u3*.5,.35+u3*.35,1.05+u4*.15,.72+u5*.15,.9+u4*.2);       // heather
     else if(M==='shoreline')out[4].push(x,y-.06,z,u2*6.283,.9+u3*.7,.9+u3*.7,.75+u4*.3,.85+u5*.2,.7+u4*.2);                   // sword fern
     else out[4].push(x,y-.04,z,u2*6.283,.7+u3*.6,.7+u3*.6,.8+u4*.35,.9+u5*.2,.75+u4*.2);}
    else if(u1<pf+pb){if(M==='desert')out[5].push(x,y-.05,z,u2*6.283,.45+u3*.5,.4+u3*.4,1.7+u4*.2,1.25+u5*.1,.55+u4*.1);  // rabbitbrush (yellow bloom)
     else if(M==='widowmaker')out[5].push(x,y-.05,z,u2*6.283,.18+u3*.2,.12+u3*.12,.75+u4*.2,.85+u5*.2,.8+u4*.2);   // low juniper / krummholz mats
     else if(M==='shoreline')out[5].push(x,y-.08,z,u2*6.283,.7+u3*.7,.55+u3*.5,.8+u4*.3,.9+u5*.2,.75+u4*.2);                  // salal / huckleberry
     else {const asp=aspenAt(x,z)>.5;out[5].push(x,y-.08,z,u2*6.283,.6+u3*.8,.6+u3*.8,asp?1.1:.85+u4*.3,asp?1:.9+u5*.2,asp?.7:.8+u4*.2);}}
    else if(u1<pf+pb+B.sap&&(M==='desert'||f>.03&&f<(M==='shoreline'?.95:.6))&&u5<.35&&clearAt(x,z)<=0){
     const s0=M==='shoreline'?.035+u3*.05:M==='widowmaker'?.15+u3*.2:M==='desert'?.25+u3*.3:.07+u3*.09;out[u4<.5?6:7].push(x,y-.05,z,u2*6.283,s0,s0,.8+u4*.3,.88+u5*.25,.85+u4*.2);}}
   const pp=(rk*.5+.03)*B.peb+(cliff>.5?(ALP?.08:M==='widowmaker'||M==='desert'?.15:.6):0);
   if(u5<pp&&dirt<.7){const sc=(.1+u3*u3*.45)*(cliff>.5?1.5:1);const moss=M==='shoreline',sand=M==='desert';out[8].push(x,y-sc*.25,z,u2*6.283,sc,sc*(.8+u4*.4),moss?.75:sand?1.25+u3*.15:.9+u3*.2,moss?.9:sand?.8+u3*.1:.9+u3*.18,moss?.65:sand?.6:.88+u3*.15);}}}
 for(let k=0;k<GROUND_KEYS.length;k++)offs[k][SUB*SUB]=out[k].length/G_STRIDE;
 return {ground:out.map(a=>new Float32Array(a)),offs};}

// worker entry
if(typeof self!=='undefined'&&typeof window==='undefined'&&typeof self.postMessage==='function'){
 self.onmessage=e=>{const {id,op,i,j,mobile,mtn}=e.data;if(mtn&&mtn!==MOUNTAIN.id)setMountain(mtn);try{
  const t0=performance.now();
  if(op==='tile'){const t=genTile(i,j);t.ms=performance.now()-t0;self.postMessage({id,res:t},[t.trees.buffer,t.props.buffer,t.col.buffer]);}
  else{const g=genGround(i,j,mobile);g.ms=performance.now()-t0;self.postMessage({id,res:g},[...g.ground.map(a=>a.buffer),...g.offs.map(a=>a.buffer)]);}
 }catch(err){self.postMessage({id,err:String(err&&err.stack||err)});}};}
