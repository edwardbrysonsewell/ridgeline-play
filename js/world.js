import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import {clamp,lerp,smooth,damp,rng,$,noise2,fbm,isMobile,SUN,FOG_BASE,FOG_SUN,GLSL_NOISE,MOUNTAIN} from './core.js';
// ═════════════════════════════════════════════════════════════════════════════
// Sky, light, shadows, atmosphere and the post chain.
//
// Frame (mobile cost in brackets, relative to the main scene pass = 1.0):
//   shadow cascades ......... 2 maps mobile (far one every other frame) / 3 desktop   [~0.3]
//   main scene → HDR target . MSAA×4 desktop; depth texture kept for the passes below
//   SSAO .................... desktop only, half res, 12 taps + 4×4 bilateral blur
//   god rays ................ quarter res: sky-mask prep + 2 radial blurs               [~0.05]
//   particles ............... half res, soft depth fade, lit by sun + cascade-0 shadow [~0.05]
//   bloom ................... 13-tap down / tent up chain from half res, 4–5 levels    [~0.08]
//   composite ............... full res: AO, particles, rays, bloom, speed blur, ACES, grade
//   FXAA .................... mobile only (desktop has MSAA)                           [~0.1]
// ═════════════════════════════════════════════════════════════════════════════

const Q={
 msaa:isMobile?0:4,
 cascades:isMobile?2:3,
 shadowSize:isMobile?[2048,1024]:[2048,2048,2048],
 splits:isMobile?[18,80]:[13,45,150],   // far edge (m) of each cascade along the view
 ssao:!isMobile,
 rayTaps:isMobile?12:16,
 bloomLevels:isMobile?4:5,
 fxaa:isMobile,
 blurTaps:isMobile?4:8,
};

// ───────────────────────── renderer, scene, camera
const canvas=$('c');
const renderer=new THREE.WebGLRenderer({canvas,antialias:false,stencil:false,powerPreference:'high-performance'});
renderer.toneMapping=THREE.NoToneMapping;   // tone mapping + grade happen in the composite pass
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(62,innerWidth/innerHeight,.15,3000);

// ───────────────────────── atmosphere model
// Cheap analytic single scattering (uniform-medium closed form) with a Rayleigh + two-lobe Mie phase.
// The SAME function colours the sky dome, the fog on every material, the distant ranges and the
// environment map, so the horizon and the fog always agree in every direction.
const ATM={TR:[.040,.098,.235],TM:.052,SUNE:2.35,AMB:[.030,.050,.095]};
const S3=v=>`vec3(${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)})`;
const V3s=a=>`vec3(${a.map(x=>x.toFixed(5)).join(',')})`;
const ATMOS_GLSL=`
#ifndef ATM_DEFINED
#define ATM_DEFINED
#define ATM_SUN ${S3(SUN)}
const vec3 ATM_TR=${V3s(ATM.TR)};
const float ATM_TM=${ATM.TM.toFixed(4)};
const vec3 ATM_AMB=${V3s(ATM.AMB)};
float atmAirmass(float y){y=max(y,0.0);return 1.0/(y+0.08*exp(-y*9.0)+0.0035);}
vec3 atmSunT(float k){return exp(-(ATM_TR+ATM_TM)*atmAirmass(ATM_SUN.y)*k);}
float atmHG(float mu,float g){float g2=g*g;return (1.0-g2)/pow(max(1.0+g2-2.0*g*mu,1e-4),1.5);}
vec3 atmSky(vec3 d){
 float y=max(d.y,0.0),mu=dot(d,ATM_SUN);
 float am=atmAirmass(y);
 vec3 tR=ATM_TR*am;float tM=ATM_TM*am;
 vec3 ext=exp(-(tR+tM));
 // sunlight reaching the scattering air: high views see light that crossed less low air
 vec3 Ts=atmSunT(mix(1.0,0.42,sqrt(y)));
 float pM=min(atmHG(mu,0.78)*0.75+atmHG(mu,0.25)*0.25,5.0);
 vec3 sc=(tR*(0.75*(1.0+mu*mu))+tM*pM)/(tR+tM)*(1.0-ext);
 return ${ATM.SUNE.toFixed(3)}*Ts*sc+ATM_AMB*(1.0-ext*0.6)*(0.7+0.3*y);
}
vec3 atmFog(vec3 d){return atmSky(normalize(vec3(d.x,max(d.y,0.0)+1e-3,d.z)));}
// Fog amount along a ray of length L (m) that climbs dy (m): exp² aerial haze + an exponential
// height layer anchored at the camera (denser down in the valleys, thinner up the slopes).
float atmFogAmount(float L,float dy,float dens){
 float a=dens*L;
 float k=dy*0.022;
 float hf=abs(k)>1e-3?(1.0-exp(-k))/k:1.0;
 // the valley haze layer thins with the air on clearer mountains (dens below the default .0021); at the default it is
 // exactly the original 0.00045
 float tau=a*a+(dens<0.00205?dens*(0.00045/0.0021):0.00045)*L*min(hf,8.0);
 return 1.0-exp(-tau);
}
#endif
`;
// JS mirror for the light colours
const airmass=y=>{y=Math.max(y,0);return 1/(y+.08*Math.exp(-y*9)+.0035);};
const sunT=k=>ATM.TR.map(t=>Math.exp(-(t+ATM.TM)*airmass(SUN.y)*k));
const SUN_RGB=(()=>{const t=sunT(1),m=Math.max(...t);return new THREE.Color().setRGB(t[0]/m,t[1]/m,t[2]/m).lerp(new THREE.Color(1,.93,.84),.32);})();

scene.fog=new THREE.FogExp2(new THREE.Color(1,1,1),.0021);   // fog.color is a tint on the atmosphere colour
// Per-mountain air: aerial-haze density and a tint on the atmosphere colour. Mountains not listed keep the original
// values (density .0021, no tint). Razorback's thin, dry high-alpine air is clearer, so its long views keep their depth.
// Hollowfell's damp highland air is a touch hazier than Razorback's but cooler and darker-tinted, so the forest stays
// deep green instead of washing out to white.
const AIR={razorback:{d:.0013,c:[1,1,1]},hollowfell:{d:.0016,c:[.86,.93,.9]}},AIR0={d:.0021,c:[1,1,1]};
function setAir(){const a=AIR[MOUNTAIN.id]||AIR0;scene.fog.density=a.d;scene.fog.color.setRGB(a.c[0],a.c[1],a.c[2]);}

// Sun-aware fog through the standard chunks: every built-in material picks this up.
// vFogDepth (view depth) is kept because terrain.js reads it.
THREE.ShaderChunk.fog_pars_vertex='#ifdef USE_FOG\n varying float vFogDepth; varying vec3 vFogView;\n#endif';
THREE.ShaderChunk.fog_vertex='#ifdef USE_FOG\n vFogDepth=-mvPosition.z; vFogView=mvPosition.xyz;\n#endif';
THREE.ShaderChunk.fog_pars_fragment='#ifdef USE_FOG\n uniform vec3 fogColor; varying float vFogDepth; varying vec3 vFogView;\n #ifdef FOG_EXP2\n uniform float fogDensity;\n #else\n uniform float fogNear; uniform float fogFar;\n #endif\n'+ATMOS_GLSL+'\n#endif';
THREE.ShaderChunk.fog_fragment=`#ifdef USE_FOG
 vec3 fogW=(vec4(vFogView,0.0)*viewMatrix).xyz;
 float fogL=length(fogW);
 #ifdef FOG_EXP2
  float fogFactor=atmFogAmount(fogL,fogW.y,fogDensity);
 #else
  float fogFactor=smoothstep(fogNear,fogFar,vFogDepth);
 #endif
 gl_FragColor.rgb=mix(gl_FragColor.rgb,atmFog(fogW/max(fogL,1e-3))*fogColor,fogFactor);
#endif`;

// ───────────────────────── sun, cascaded shadows, ambient
// Cascades without per-material setup: cascade 0 is the real sun; cascades 1..N-1 are black
// proxy lights that only own a shadow map. The patched lights chunk picks, per fragment, the
// finest cascade whose map covers it (cross-fading at the borders) and skips the proxies.
// The cascade lights are the first shadow-casting directional lights in the scene, so any light
// another module adds later keeps its normal behaviour.
const NC=Q.cascades;
const SUN_I=7.0;
const sun=new THREE.DirectionalLight(SUN_RGB.clone(),SUN_I);
const cascades=[];
for(let i=0;i<NC;i++){const L=i===0?sun:new THREE.DirectionalLight(0x000000,0);
 L.castShadow=true;L.shadow.mapSize.set(Q.shadowSize[i],Q.shadowSize[i]);L.shadow.camera.near=1;L.shadow.camera.far=700;
 if(i>0&&isMobile)L.shadow.autoUpdate=false;
 scene.add(L,L.target);cascades.push({L,r:0});}
{const csmFn=[];
 csmFn.push('float csmShadow(){float s=1.0,w=1.0;vec3 p;vec2 m;float e,a;');
 for(let i=0;i<NC;i++){
  csmFn.push(`p=vDirectionalShadowCoord[${i}].xyz/vDirectionalShadowCoord[${i}].w;m=abs(p.xy-0.5)*2.0;e=max(m.x,m.y);
  if(e<1.0&&p.z<1.0&&w>0.0){a=getShadow(directionalShadowMap[${i}],directionalLightShadows[${i}].shadowMapSize,directionalLightShadows[${i}].shadowBias,directionalLightShadows[${i}].shadowRadius,vDirectionalShadowCoord[${i}]);
   float b=${i===NC-1?'1.0-smoothstep(0.75,0.98,e)':'1.0-smoothstep(0.82,0.97,e)'};
   s=mix(s,a,w*b);w*=1.0-b;}`);}
 csmFn.push('return s;}');
 THREE.ShaderChunk.shadowmap_pars_fragment+=`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS >= ${NC}
${csmFn.join('\n')}
#endif`;
 const lf=THREE.ShaderChunk.lights_fragment_begin;
 const a=lf.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'),b=lf.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )');
 if(a<0||b<0)console.warn('world.js: lights chunk layout changed; cascades disabled');
 else THREE.ShaderChunk.lights_fragment_begin=lf.slice(0,a)+`
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS >= ${NC} ) && ( UNROLLED_LOOP_INDEX > 0 ) && ( UNROLLED_LOOP_INDEX < ${NC} )
		#else
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS >= ${NC} ) && ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= ( directLight.visible && receiveShadow ) ? csmShadow() : 1.0;
		#elif defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif
	}
	#pragma unroll_loop_end
#endif
`+lf.slice(b);}
// Hemisphere: a faint warm ground bounce; the sky's share of the ambient comes from the env map.
const hemi=new THREE.HemisphereLight(new THREE.Color().setRGB(.32,.42,.62),new THREE.Color().setRGB(.34,.26,.14),.4);
scene.add(hemi);

// Light-space basis that matches DirectionalLightShadow's lookAt (up = +y), for texel snapping.
const LZ=SUN.clone().normalize(),LX=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),LZ).normalize(),LY=new THREE.Vector3().crossVectors(LZ,LX);
const _fw=new THREE.Vector3(),_c=new THREE.Vector3();
let frameNo=0;
// Bounding sphere of each view-frustum slice → orthographic box of fixed size (radius is quantised,
// so the texel size only changes in rare steps) whose centre is snapped to whole texels: no shimmer.
function fitCascades(){
 const tanY=Math.tan(THREE.MathUtils.degToRad(camera.fov/2)),tanX=tanY*camera.aspect,k=tanX*tanX+tanY*tanY;
 camera.getWorldDirection(_fw);
 let n=camera.near;
 for(let i=0;i<NC;i++){const C=cascades[i],L=C.L,f=Q.splits[i];
  if(i>0&&isMobile&&(frameNo&1)){n=f;continue;}   // mobile: far cascade refreshes on alternate frames
  const zc=Math.min(f,.5*(n+f)*(1+k));
  let r=Math.max(Math.hypot(f-zc,f*Math.sqrt(k)),Math.hypot(zc-n,n*Math.sqrt(k)));
  r=Math.pow(1.06,Math.ceil(Math.log(r)/Math.log(1.06)));
  const sz=Q.shadowSize[i],tex=2*r/sz;
  _c.copy(camera.position).addScaledVector(_fw,zc);
  const cx=Math.floor(_c.dot(LX)/tex)*tex,cy=Math.floor(_c.dot(LY)/tex)*tex,cz=_c.dot(LZ);
  _c.copy(LX).multiplyScalar(cx).addScaledVector(LY,cy).addScaledVector(LZ,cz);
  L.target.position.copy(_c);L.position.copy(_c).addScaledVector(LZ,320);
  const sc=L.shadow.camera;
  if(C.r!==r){C.r=r;sc.left=-r;sc.right=r;sc.top=r;sc.bottom=-r;sc.near=1;sc.far=320+r+60;sc.updateProjectionMatrix();
   L.shadow.normalBias=tex*1.4;L.shadow.bias=-tex*.6/(sc.far-sc.near);}
  if(!L.shadow.autoUpdate)L.shadow.needsUpdate=true;
  n=f;}
}

// ───────────────────────── sky dome
const skyU={uTime:{value:0},uEnv:{value:0}};
const skyMat=new THREE.ShaderMaterial({uniforms:skyU,side:THREE.BackSide,depthWrite:false,fog:false,
 vertexShader:`varying vec3 vDir;void main(){vDir=position;vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_Position=p.xyww;}`,
 fragmentShader:`uniform float uTime;uniform float uEnv;varying vec3 vDir;${GLSL_NOISE}${ATMOS_GLSL}
 void main(){vec3 d=normalize(vDir);
  float mu=dot(d,ATM_SUN);
  vec3 col=atmFog(d);
  vec3 sunC=${ATM.SUNE.toFixed(3)}*atmSunT(1.0);
  if(d.y>0.0){
   // clouds: a broken cumulus deck + high cirrus, both lit from the low sun
   float h=d.y;vec2 uv=d.xz/(h+.09);vec2 wind=vec2(uTime*.0045,uTime*.0012);
   vec2 sd2=normalize(ATM_SUN.xz);
   float b1=fbm3(uv*.55+wind),b2=fbm3(uv*2.1-wind*1.7+3.1);
   float dens=smoothstep(.40,.74,b1*.78+b2*.32);
   float densS=smoothstep(.40,.74,fbm3((uv+sd2*.10)*.55+wind)*.78+b2*.32);
   float thick=clamp(dens*1.2+densS*.6,0.,1.);
   float lit=clamp(1.-(densS-dens*.35)*1.4,.15,1.);
   float edge=(1.-dens)*atmHG(mu,.65)*.35;   // silver lining toward the sun
   vec3 cShade=(atmSky(vec3(0.,1.,0.))*1.5+atmFog(d)*.45)*vec3(1.,.97,1.02);
   vec3 cLit=sunC*(.42*lit+edge*.22);
   vec3 cc=cShade*(1.-.3*thick)+cLit*(1.-.25*thick);
   float far=1.-exp(-atmAirmass(h)*.07);
   cc=mix(cc,col,far);
   float ci=fbm3(vec2(uv.x*.18+uv.y*.05,uv.y*1.6-uv.x*.4)+wind*.6+11.)*fbm3(uv*.9+wind+5.);
   float cir=smoothstep(.28,.6,ci)*smoothstep(.05,.3,h)*.45;
   col=mix(col,cShade*.9+sunC*.035*(1.+atmHG(mu,.7)*.3),cir*(1.-dens));
   col=mix(col,cc,dens*smoothstep(.0,.10,h)*.92);
  }
  if(uEnv>.5){ // env map: no sun disc; below the horizon, light bounced from sunlit forest floor
   float g=smoothstep(.0,-.25,d.y);col=mix(col*2.0,vec3(.07,.062,.035)*1.4+sunC*.014,g);
  }else{
   float r=acos(clamp(mu,-1.,1.));
   float disc=1.-smoothstep(.0085,.0105,r);float limb=sqrt(max(1.-pow(r/.0105,2.),0.));
   col+=sunC*atmSunT(.25)*disc*(.35+.65*limb)*16.;
   col+=sunC*(exp(-r*55.)*.9+exp(-r*12.)*.18);       // aureole that the bloom spreads further
   col*=1.-smoothstep(.0,-.4,d.y)*.15;
  }
  gl_FragColor=vec4(col,1.);}`});
const sky=new THREE.Mesh(new THREE.SphereGeometry(1000,48,24),skyMat);sky.renderOrder=-10;sky.frustumCulled=false;scene.add(sky);

// Environment light from the sky (no sun disc; lower hemisphere = ground bounce)
function buildEnv(){const pm=new THREE.PMREMGenerator(renderer);const es=new THREE.Scene();const sm=sky.clone();es.add(sm);
 skyU.uEnv.value=1;const rt=pm.fromScene(es,.04);skyU.uEnv.value=0;pm.dispose();return rt.texture;}
scene.environment=buildEnv();

// ───────────────────────── distant ranges: layered ridgelines hazed with the same atmosphere
const ranges=new THREE.Group();scene.add(ranges);
const rangeMat=new THREE.ShaderMaterial({side:THREE.DoubleSide,fog:false,uniforms:{},
 vertexShader:`attribute vec3 aInfo;varying vec3 vW;varying vec3 vInfo;varying vec3 vN;
  void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;vInfo=aInfo;vN=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*viewMatrix*w;}`,
 fragmentShader:`${ATMOS_GLSL}varying vec3 vW;varying vec3 vInfo;varying vec3 vN;
  void main(){vec3 v=vW-cameraPosition;vec3 d=normalize(v);
   float hgt=vInfo.x,haze=vInfo.y,snow=vInfo.z;
   vec3 n=normalize(vN);if(dot(n,d)>0.)n=-n;
   float sl=clamp(dot(n,ATM_SUN)*1.4+.25,0.,1.);
   vec3 sunC=${ATM.SUNE.toFixed(3)}*atmSunT(1.)*.06;
   vec3 alb=mix(vec3(.030,.045,.040),vec3(.10,.095,.09),smoothstep(.55,1.,hgt));
   alb=mix(alb,vec3(.55,.55,.58),snow);
   vec3 lit=alb*(sunC*sl+atmSky(vec3(0.,1.,0.))*.9);
   float h=haze+(1.-haze)*(1.-smoothstep(.0,.75,hgt))*.85;
   gl_FragColor=vec4(mix(lit,atmFog(d),clamp(h,0.,1.)),1.);}`});
{const r=rng(9);
 for(let L=0;L<3;L++){const R=1650+L*380,seg=240,pos=[],info=[],idx=[];
  const amp=[230,360,520][L],haze=[.50,.66,.80][L];
  for(let i=0;i<=seg;i++){const a=i/seg*Math.PI*2,x=Math.cos(a)*R,z=Math.sin(a)*R;
   const n=fbm(Math.cos(a)*3+L*10,Math.sin(a)*3,5)*.5+.5;const ridge=1-Math.abs(fbm(a*4+L*3.1,L,3));
   const H=amp*(.22+.78*n*ridge)+40;const snow=L===2&&H>amp*.72?.6:0;
   pos.push(x,-300,z, x,H*.6,z, x,H,z);
   info.push(0,haze,0, .6,haze,0, 1,haze,snow);
   if(i<seg){const k=i*3;for(const q of[[0,1,3],[1,4,3],[1,2,4],[2,5,4]])idx.push(k+q[0],k+q[1],k+q[2]);}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('aInfo',new THREE.Float32BufferAttribute(info,3));g.setIndex(idx);g.computeVertexNormals();
  const m=new THREE.Mesh(g,rangeMat);m.renderOrder=-9-L;m.frustumCulled=false;ranges.add(m);
 }}

// ───────────────────────── render targets & full-screen pass helper
const HF=THREE.HalfFloatType;
const mkRT=(o={})=>new THREE.WebGLRenderTarget(2,2,Object.assign({type:HF,depthBuffer:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter},o));
const sceneDepth=new THREE.DepthTexture(2,2,THREE.UnsignedIntType);
const rtScene=new THREE.WebGLRenderTarget(2,2,{type:HF,samples:Q.msaa,depthBuffer:true,depthTexture:sceneDepth});
const rtAO=mkRT({type:THREE.UnsignedByteType}),rtAO2=mkRT({type:THREE.UnsignedByteType});
const rtR1=mkRT(),rtR2=mkRT();
const rtFx=mkRT();
const rtBloom=[];for(let i=0;i<Q.bloomLevels;i++)rtBloom.push(mkRT());
const rtLDR=mkRT({type:THREE.UnsignedByteType});

const fsCam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
const fsGeo=new THREE.BufferGeometry();
fsGeo.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));fsGeo.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,2,0,0,2],2));
const fsMesh=new THREE.Mesh(fsGeo);fsMesh.frustumCulled=false;const fsScene=new THREE.Scene();fsScene.add(fsMesh);
const FSV='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
const fsMat=(fs,uniforms,o={})=>new THREE.ShaderMaterial(Object.assign({vertexShader:FSV,fragmentShader:fs,uniforms,depthTest:false,depthWrite:false},o));
function pass(mat,target){fsMesh.material=mat;renderer.setRenderTarget(target);renderer.render(fsScene,fsCam);}
const IGN='float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}';
const LINZ=`uniform float uNear,uFar;float linZ(float d){return uNear*uFar/(uFar-d*(uFar-uNear));}`;

// ───────────────────────── SSAO (desktop): depth-only, normals from depth, 4×4 interleaved rotation
const aoMat=fsMat(`uniform sampler2D tDepth;uniform mat4 uProjInv;uniform vec2 uTexel;uniform float uProjY;varying vec2 vUv;
 vec3 vp(vec2 uv){float d=texture2D(tDepth,uv).r;vec4 p=uProjInv*vec4(vec3(uv,d)*2.-1.,1.);return p.xyz/p.w;}
 void main(){float d0=texture2D(tDepth,vUv).r;if(d0>=.99999){gl_FragColor=vec4(1.);return;}
  vec3 P=vp(vUv);
  vec3 px=vp(vUv+vec2(uTexel.x,0.))-P,nx=P-vp(vUv-vec2(uTexel.x,0.));
  vec3 py=vp(vUv+vec2(0.,uTexel.y))-P,ny=P-vp(vUv-vec2(0.,uTexel.y));
  vec3 dx=abs(px.z)<abs(nx.z)?px:nx,dy=abs(py.z)<abs(ny.z)?py:ny;
  vec3 N=normalize(cross(dx,dy));
  float R=.75,sr=R*uProjY*.5/-P.z;
  vec2 ip=mod(floor(gl_FragCoord.xy),4.);float rot=(ip.x+ip.y*4.)/16.*6.2832;
  float ao=0.;
  for(int i=0;i<12;i++){float t=(float(i)+.5)/12.;float a=rot+float(i)*2.3999;
   vec2 o=vec2(cos(a),sin(a))*sr*t*t;vec3 v=vp(vUv+o)-P;float vv=dot(v,v);
   ao+=max(0.,dot(v,N)+P.z*.004)/(vv+.02)*(1.-smoothstep(R*R*.6,R*R*2.,vv));}
  ao=clamp(1.-ao*1.2/12.,0.,1.);
  ao=mix(ao,1.,smoothstep(30.,70.,-P.z));
  gl_FragColor=vec4(ao,0.,0.,1.);}`,
 {tDepth:{value:sceneDepth},uProjInv:{value:new THREE.Matrix4()},uTexel:{value:new THREE.Vector2()},uProjY:{value:1}});
const aoBlurMat=fsMat(`uniform sampler2D tAO;uniform sampler2D tDepth;uniform vec2 uTexel;${LINZ}varying vec2 vUv;
 void main(){float z0=linZ(texture2D(tDepth,vUv).r);float s=0.,w=0.;
  for(int y=-2;y<2;y++)for(int x=-2;x<2;x++){vec2 o=(vec2(x,y)+.5)*uTexel;float z=linZ(texture2D(tDepth,vUv+o).r);
   float k=1./(1.+abs(z-z0)/(z0*.04+.05)*4.);s+=texture2D(tAO,vUv+o).r*k;w+=k;}
  gl_FragColor=vec4(s/w,0.,0.,1.);}`,
 {tAO:{value:rtAO.texture},tDepth:{value:sceneDepth},uTexel:{value:new THREE.Vector2()},uNear:{value:.15},uFar:{value:3000}});

// ───────────────────────── god rays: sky mask near the sun, radial blur toward it (quarter res)
const rayPrepMat=fsMat(`uniform sampler2D tScene,tDepth;uniform vec2 uSun;uniform float uAspect;uniform vec2 uTexel;varying vec2 vUv;
 void main(){float m=0.;
  for(int i=0;i<4;i++){vec2 o=(vec2(i&1,i>>1)-.5)*uTexel;m+=step(.999995,texture2D(tDepth,vUv+o).r);}
  m*=.25;vec2 dv=(vUv-uSun)*vec2(uAspect,1.);
  vec3 c=texture2D(tScene,vUv).rgb;c=(any(isnan(c))||any(isinf(c)))?vec3(0.):min(c,vec3(4.));
  gl_FragColor=vec4(c*m*exp(-dot(dv,dv)*9.),1.);}`,
 {tScene:{value:rtScene.texture},tDepth:{value:sceneDepth},uSun:{value:new THREE.Vector2()},uAspect:{value:1},uTexel:{value:new THREE.Vector2()}});
const rayBlurMat=fsMat(`${IGN}uniform sampler2D tSrc;uniform vec2 uSun;uniform float uLen;varying vec2 vUv;
 void main(){vec2 d=(uSun-vUv)*uLen/float(TAPS);vec2 p=vUv+d*ign(gl_FragCoord.xy);vec3 acc=vec3(0.);float w=1.,ws=0.;
  for(int i=0;i<TAPS;i++){acc+=texture2D(tSrc,p).rgb*w;ws+=w;w*=.94;p+=d;}
  gl_FragColor=vec4(acc/ws,1.);}`,
 {tSrc:{value:null},uSun:{value:new THREE.Vector2()},uLen:{value:1}},{defines:{TAPS:Q.rayTaps}});

// ───────────────────────── bloom: 13-tap downsample (Karis-averaged first level) + tent upsample
const bloomDown=fsMat(`uniform sampler2D tSrc;uniform vec2 uTexel;uniform float uFirst;varying vec2 vUv;
 vec3 T(vec2 o){vec3 c=texture2D(tSrc,vUv+o*uTexel).rgb;
  if(uFirst>.5)c=(any(isnan(c))||any(isinf(c)))?vec3(0.):min(c,vec3(500.));   // stray NaN/Inf must not smear into blocks
  return c;}
 float kw(vec3 c){return 1./(1.+dot(c,vec3(.2126,.7152,.0722)));}
 void main(){vec3 a=T(vec2(-2,2)),b=T(vec2(0,2)),c=T(vec2(2,2)),d=T(vec2(-2,0)),e=T(vec2(0)),f=T(vec2(2,0)),g=T(vec2(-2,-2)),h=T(vec2(0,-2)),i=T(vec2(2,-2)),
  j=T(vec2(-1,1)),k=T(vec2(1,1)),l=T(vec2(-1,-1)),m=T(vec2(1,-1));
  vec3 g0=(a+b+d+e)*.25,g1=(b+c+e+f)*.25,g2=(d+e+g+h)*.25,g3=(e+f+h+i)*.25,g4=(j+k+l+m)*.25;
  vec4 w=vec4(.125,.125,.125,.125);float w4=.5;
  if(uFirst>.5){w*=vec4(kw(g0),kw(g1),kw(g2),kw(g3));w4*=kw(g4);float s=w.x+w.y+w.z+w.w+w4;w/=s;w4/=s;}
  vec3 o=g0*w.x+g1*w.y+g2*w.z+g3*w.w+g4*w4;
  if(uFirst>.5){float l=dot(o,vec3(.2126,.7152,.0722));float t=1.1,kn=.6;float sft=clamp(l-t+kn,0.,2.*kn);sft=sft*sft/(4.*kn+1e-4);o*=max(sft,l-t)/max(l,1e-4);}
  gl_FragColor=vec4(o,1.);}`,{tSrc:{value:null},uTexel:{value:new THREE.Vector2()},uFirst:{value:0}});
const bloomUp=fsMat(`uniform sampler2D tSrc;uniform vec2 uTexel;varying vec2 vUv;
 vec3 T(vec2 o){return texture2D(tSrc,vUv+o*uTexel).rgb;}
 void main(){vec3 s=T(vec2(0))*4.+(T(vec2(-1,0))+T(vec2(1,0))+T(vec2(0,-1))+T(vec2(0,1)))*2.+T(vec2(-1,-1))+T(vec2(1,-1))+T(vec2(-1,1))+T(vec2(1,1));
  gl_FragColor=vec4(s/16.,1.);}`,{tSrc:{value:null},uTexel:{value:new THREE.Vector2()}},
 {blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,blendSrc:THREE.OneFactor,blendDst:THREE.OneFactor});

// ───────────────────────── composite: AO, particles, rays, bloom, speed blur, ACES, grade
const compMat=fsMat(`${IGN}uniform sampler2D tScene,tAO,tFx,tRays,tBloom;
 uniform float uAO,uSpeed,uCA,uBloom,uExposure,uVig,uTime,uDebug;uniform vec3 uRayCol;varying vec2 vUv;
 vec3 aces(vec3 c){const mat3 I=mat3(.59719,.07600,.02840,.35458,.90834,.13383,.04823,.01566,.83777);
  const mat3 O=mat3(1.60475,-.10208,-.00327,-.53108,1.10813,-.07276,-.07367,-.00605,1.07602);
  c=I*c;vec3 a=c*(c+.0245786)-.000090537,b=c*(.983729*c+.4329510)+.238081;return clamp(O*(a/b),0.,1.);}
 vec3 srgb(vec3 c){return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(.0031308,c));}
 void main(){vec2 uv=vUv;vec2 dv=uv-.5;
  vec3 c=texture2D(tScene,uv).rgb;if(any(isnan(c)))c=vec3(0.);
  if(uCA>.001){vec2 o=dv*uCA*.008;c.r=texture2D(tScene,uv+o).r;c.b=texture2D(tScene,uv-o).b;}
  if(uSpeed>.001){float j=ign(gl_FragCoord.xy+uTime);vec3 acc=c;
   for(int i=1;i<=BLUR;i++){float t=(float(i)-j)/float(BLUR);acc+=texture2D(tScene,uv-dv*t*uSpeed*.036).rgb;}
   c=acc/float(BLUR+1);}
  ${'#ifdef USE_AO'}
  c*=mix(1.,texture2D(tAO,uv).r,uAO);
  ${'#endif'}
  vec4 fx=texture2D(tFx,uv);c=c*(1.-fx.a)+fx.rgb;
  c+=texture2D(tRays,uv).rgb*uRayCol;
  c+=texture2D(tBloom,uv).rgb*uBloom;
  c*=uExposure;
  c=aces(c);
  float l=dot(c,vec3(.2126,.7152,.0722));
  c=mix(c,c*vec3(.90,.99,1.12),(1.-smoothstep(.0,.30,l))*.45);   // cool shadows
  c=mix(c,c*vec3(1.06,1.0,.92),smoothstep(.30,.95,l)*.32);      // warm highlights
  c=max(mix(vec3(l),c,1.06),0.);
  float r=dot(dv*vec2(1.1,1.),dv*vec2(1.1,1.));c*=1.-r*uVig;
  c=srgb(clamp(c,0.,1.));
  c=mix(c,c*c*(3.-2.*c),.22);   // gentle S-curve in display space
  c+=(ign(gl_FragCoord.xy)-.5)/255.;
  if(uDebug>.5){vec3 dbg=uDebug<1.5?vec3(texture2D(tAO,uv).r):uDebug<2.5?texture2D(tRays,uv).rgb:texture2D(tFx,uv).rgb;gl_FragColor=vec4(dbg,1.);return;}
  gl_FragColor=vec4(c,1.);}`,
 {tScene:{value:rtScene.texture},tAO:{value:rtAO2.texture},tFx:{value:rtFx.texture},tRays:{value:rtR1.texture},tBloom:{value:rtBloom[0].texture},
  uAO:{value:.8},uSpeed:{value:0},uCA:{value:0},uBloom:{value:.16},uExposure:{value:1.0},uVig:{value:.55},uTime:{value:0},uDebug:{value:0},uRayCol:{value:new THREE.Color()}},
 {defines:Object.assign({BLUR:Q.blurTaps},Q.ssao?{USE_AO:''}:{})});
const fxaaMat=fsMat(FXAAShader.fragmentShader,{tDiffuse:{value:rtLDR.texture},resolution:{value:new THREE.Vector2()}});

// ───────────────────────── particles (rendered at half res into their own target, soft depth fade)
function puffAtlas(){const N=128,c=document.createElement('canvas');c.width=c.height=N*2;const x=c.getContext('2d');const img=x.createImageData(N*2,N*2);
 for(let t=0;t<4;t++){const ox=(t&1)*N,oy=(t>>1)*N;
  for(let j=0;j<N;j++)for(let i=0;i<N;i++){const u=i/N*2-1,v=j/N*2-1,r=Math.hypot(u,v);
   const n=fbm(i*.045+t*17.3,j*.045+t*9.1,4)*.5+.5,n2=fbm(i*.11+t*3.7,j*.11,3)*.5+.5;
   const fall=Math.max(0,1-r);const a=Math.pow(fall,1.4)*Math.min(1,Math.max(0,(n*1.25+n2*.35-.38)*1.9+fall*.6));
   const k=((oy+j)*N*2+ox+i)*4;img.data[k]=img.data[k+1]=img.data[k+2]=255;img.data[k+3]=Math.round(Math.min(1,a)*255);}}
 x.putImageData(img,0,0);const tx=new THREE.CanvasTexture(c);tx.generateMipmaps=true;tx.minFilter=THREE.LinearMipmapLinearFilter;return tx;}
function softTex(){const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');const g=x.createRadialGradient(32,32,0,32,32,32);
 g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(.4,'rgba(255,255,255,.5)');g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(0,0,64,64);return new THREE.CanvasTexture(c);}
const SOFT=softTex(),PUFF=puffAtlas();
const fxScene=new THREE.Scene();
const sunCol=new THREE.Color().copy(SUN_RGB).multiplyScalar(SUN_I);
const fxU={uDepth:{value:sceneDepth},uRes:{value:new THREE.Vector2(1,1)},uNear:{value:.15},uFar:{value:3000},uScale:{value:500},
 uShadow:{value:null},uShadowM:{value:new THREE.Matrix4()},uHasShadow:{value:0},uSunCol:{value:sunCol},uFogD:{value:.0029}};
// mode 0 = dust (lit puffs), 1 = debris (small solid chips), 2 = motes (additive sparkle)
function particleMat(mode,color){
 return new THREE.ShaderMaterial({transparent:true,depthTest:false,depthWrite:false,
  blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.OneMinusSrcAlphaFactor,
  uniforms:Object.assign({uColor:{value:new THREE.Color(...color)},uTex:{value:mode===0?PUFF:SOFT}},fxU),defines:{MODE:mode},
  vertexShader:`#include <packing>
   ${ATMOS_GLSL}
   attribute float aSize;attribute float aAlpha;attribute float aSeed;
   uniform float uScale,uFogD,uHasShadow;uniform sampler2D uShadow;uniform mat4 uShadowM;uniform vec3 uSunCol;uniform vec3 uColor;
   varying float vA;varying vec3 vCol;varying vec3 vFog;varying float vFogF;varying float vZ;varying float vRad;varying vec2 vRot;varying vec2 vTile;varying vec3 vL;
   void main(){vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;float z=-mv.z;vZ=z;
    float px=aSize*uScale/max(z,.1);
    vA=aAlpha*smoothstep(.25,1.6,z);
    #if MODE==2
     vA*=clamp(px/1.5,0.,1.);px=max(px,1.5);
    #endif
    gl_PointSize=min(px,256.);vRad=aSize*.5;
    float sh=1.;
    if(uHasShadow>.5){vec4 sc=uShadowM*vec4(position,1.);sc.xyz/=sc.w;
     if(all(greaterThan(sc.xy,vec2(0.)))&&all(lessThan(sc.xy,vec2(1.))))sh=step(sc.z-.002,unpackRGBAToDepth(texture2D(uShadow,sc.xy)));}
    vec3 wd=normalize(position-cameraPosition);
    float mu=dot(wd,ATM_SUN);
    vec3 amb=atmSky(vec3(0.,1.,0.))*.9+vec3(.05,.04,.025);
    #if MODE==0
     float ph=atmHG(mu,.55);
     vCol=uColor*(amb+uSunCol*sh*(.32+.28*ph));
    #elif MODE==1
     vCol=uColor*(amb*.8+uSunCol*sh*.35);
    #else
     vCol=uColor*sh*(.15+atmHG(mu,.75)*.6);
    #endif
    vFog=atmFog(wd);vFogF=atmFogAmount(z,position.y-cameraPosition.y,uFogD);
    float a=fract(sin(aSeed*91.7)*4375.85)*6.2832;vRot=vec2(cos(a),sin(a));
    float sd=floor(aSeed);vTile=vec2(mod(sd,2.),mod(floor(sd*.5),2.))*.5;
    vL=normalize((viewMatrix*vec4(ATM_SUN,0.)).xyz);}`,
  fragmentShader:`uniform sampler2D uTex,uDepth;uniform vec2 uRes;uniform float uNear,uFar;
   varying float vA;varying vec3 vCol;varying vec3 vFog;varying float vFogF;varying float vZ;varying float vRad;varying vec2 vRot;varying vec2 vTile;varying vec3 vL;
   float linZ(float d){return uNear*uFar/(uFar-d*(uFar-uNear));}
   void main(){vec2 pc=gl_PointCoord-.5;
    float sz=linZ(texture2D(uDepth,gl_FragCoord.xy/uRes).r);
    float soft=clamp((sz-vZ)/max(vRad,.05),0.,1.);
    #if MODE==0
     vec2 q=vec2(pc.x*vRot.x-pc.y*vRot.y,pc.x*vRot.y+pc.y*vRot.x)+.5;
     float t=texture2D(uTex,vTile+clamp(q,.01,.99)*.5).a;
     // sphere-ish normal so the side facing the sun is brighter (y flipped: point coords run down)
     vec2 p2=pc*2.;vec3 n=vec3(p2.x,-p2.y,sqrt(max(1.-dot(p2,p2),0.)));
     float wrap=.62+.38*dot(n,vL);
     float a=t*vA*soft;if(a<.003)discard;
     vec3 col=mix(vCol*wrap,vFog,vFogF);
     gl_FragColor=vec4(col*a,a);
    #elif MODE==1
     float a=texture2D(uTex,gl_PointCoord).a;a=smoothstep(.15,.5,a)*vA*soft;if(a<.01)discard;
     gl_FragColor=vec4(mix(vCol,vFog,vFogF)*a,a);
    #else
     float a=texture2D(uTex,gl_PointCoord).a*vA*soft*(1.-vFogF);if(a<.002)discard;
     gl_FragColor=vec4(vCol*a,0.);
    #endif
   }`});}
class Particles{constructor(max,color,mode=0){this.max=max;this.i=0;
 const g=new THREE.BufferGeometry();this.p=new Float32Array(max*3);this.sz=new Float32Array(max);this.al=new Float32Array(max);
 this.v=new Float32Array(max*3);this.age=new Float32Array(max).fill(1e9);this.life=new Float32Array(max).fill(1);this.s0=new Float32Array(max);this.a0=new Float32Array(max);
 const seed=new Float32Array(max);for(let i=0;i<max;i++)seed[i]=i*1.618%97;
 g.setAttribute('position',new THREE.BufferAttribute(this.p,3));g.setAttribute('aSize',new THREE.BufferAttribute(this.sz,1));g.setAttribute('aAlpha',new THREE.BufferAttribute(this.al,1));
 g.setAttribute('aSeed',new THREE.BufferAttribute(seed,1));
 const m=particleMat(mode===true?0:mode,color);this.u=m.uniforms;
 this.points=new THREE.Points(g,m);this.points.frustumCulled=false;fxScene.add(this.points);}
 spawn(x,y,z,vx,vy,vz,life,size,alpha){const i=this.i=(this.i+1)%this.max;this.p[i*3]=x;this.p[i*3+1]=y;this.p[i*3+2]=z;this.v[i*3]=vx;this.v[i*3+1]=vy;this.v[i*3+2]=vz;
  this.age[i]=0;this.life[i]=life;this.s0[i]=size;this.a0[i]=alpha;}
 update(dt,grow,lift,drag){for(let i=0;i<this.max;i++){if(this.age[i]>this.life[i]){this.al[i]=0;continue;}this.age[i]+=dt;const t=this.age[i]/this.life[i];
  const k=Math.exp(-drag*dt);this.v[i*3]*=k;this.v[i*3+1]=this.v[i*3+1]*k+lift*dt;this.v[i*3+2]*=k;
  this.p[i*3]+=this.v[i*3]*dt;this.p[i*3+1]+=this.v[i*3+1]*dt;this.p[i*3+2]+=this.v[i*3+2]*dt;
  this.sz[i]=this.s0[i]*(1+t*grow);this.al[i]=this.a0[i]*Math.min(1,t*8)*(1-t)*(1-t);}
  const g=this.points.geometry;g.attributes.position.needsUpdate=g.attributes.aSize.needsUpdate=g.attributes.aAlpha.needsUpdate=true;}}
// dust albedo is the trail's dry soil (linear)
const dust=new Particles(700,[.50,.37,.24],0);
const debris=new Particles(200,[.16,.10,.06],1);
// pollen motes catching the low sun
const MOTES=isMobile?200:320;const moteG=new THREE.BufferGeometry();const moteP=new Float32Array(MOTES*3),moteO=[];
for(let i=0;i<MOTES;i++){moteO.push([Math.random()*60-30,Math.random()*14-3,Math.random()*60-30,Math.random()*6.28]);}
moteG.setAttribute('position',new THREE.BufferAttribute(moteP,3));
{const sz=new Float32Array(MOTES),al=new Float32Array(MOTES),sd=new Float32Array(MOTES);for(let i=0;i<MOTES;i++){sz[i]=.05+Math.random()*.05;al[i]=.6+Math.random()*.4;sd[i]=i;}
 moteG.setAttribute('aSize',new THREE.BufferAttribute(sz,1));moteG.setAttribute('aAlpha',new THREE.BufferAttribute(al,1));moteG.setAttribute('aSeed',new THREE.BufferAttribute(sd,1));}
const motes=new THREE.Points(moteG,particleMat(2,[3.2,2.4,1.4]));motes.frustumCulled=false;fxScene.add(motes);

// ───────────────────────── quality / resize
const post={ao:Q.ssao,rays:true,bloom:.11,exposure:1.0,vig:null,Q};
let quality=1;export function setQuality(q){quality=q;resize();}export function getQuality(){return quality;}
let maxDPR=Math.min(devicePixelRatio||1,isMobile?2:1.75);
const size=new THREE.Vector2(2,2);
function resize(){const w=innerWidth,h=innerHeight;camera.aspect=w/h;camera.updateProjectionMatrix();
 const pr=maxDPR*quality;renderer.setPixelRatio(pr);renderer.setSize(w,h,false);
 renderer.getDrawingBufferSize(size);const W=size.x,H=size.y;
 const hw=Math.max(1,W>>1),hh=Math.max(1,H>>1),qw=Math.max(1,W>>2),qh=Math.max(1,H>>2);
 rtScene.setSize(W,H);rtLDR.setSize(W,H);rtAO.setSize(hw,hh);rtAO2.setSize(hw,hh);rtFx.setSize(hw,hh);rtR1.setSize(qw,qh);rtR2.setSize(qw,qh);
 for(let i=0;i<rtBloom.length;i++)rtBloom[i].setSize(Math.max(1,W>>(i+1)),Math.max(1,H>>(i+1)));
 fxU.uRes.value.set(hw,hh);fxaaMat.uniforms.resolution.value.set(1/W,1/H);
 aoMat.uniforms.uTexel.value.set(1/hw,1/hh);aoBlurMat.uniforms.uTexel.value.set(1/hw,1/hh);rayPrepMat.uniforms.uTexel.value.set(1/qw,1/qh);}
addEventListener('resize',resize);

// ───────────────────────── per-frame
// dev hook (only with #dev): lets test scripts pin the camera and tweak post settings
const DEV={cam:null};
if(location.hash==='#dev')window.__world={DEV,post,scene,camera,sun,cascades,compMat,skyU,renderer,get dust(){return dust;}};
const _sp=new THREE.Vector3(),_cf=new THREE.Vector3();
let speedK=0,sunVis=0,fpMode=false;
// focus = bike position; speed in m/s; opts = {firstPerson} (a bare boolean is accepted for compatibility)
export function updateWorld(dt,now,focus,speed,opts){
 fpMode=!!(opts&&typeof opts==='object'&&opts.firstPerson);
 setAir();
 frameNo++;
 if(DEV.cam){const c=DEV.cam;camera.position.set(...c.pos);camera.up.set(0,1,0);camera.lookAt(...c.look);if(c.fov){camera.fov=c.fov;camera.updateProjectionMatrix();}speed=0;}
 camera.updateMatrixWorld();
 sky.position.copy(camera.position);ranges.position.set(camera.position.x,Math.min(camera.position.y,focus.y)-180,camera.position.z);
 fitCascades();
 skyU.uTime.value=now/1000;
 {const cp=camera.position,t=now/1000;for(let i=0;i<MOTES;i++){const o=moteO[i];let x=o[0]+Math.sin(t*.3+o[3])*1.5,y=o[1]+Math.sin(t*.5+o[3]*2)*.6,z=o[2]+Math.cos(t*.25+o[3])*1.5;
  x=((x-cp.x)%60+90)%60-30+cp.x;z=((z-cp.z)%60+90)%60-30+cp.z;moteP[i*3]=x;moteP[i*3+1]=cp.y+y;moteP[i*3+2]=z;}moteG.attributes.position.needsUpdate=true;}
 speedK=damp(speedK,clamp((speed-9)/14,0,1),3,dt);
 // sun on screen → god-ray anchor and strength
 _sp.copy(camera.position).addScaledVector(SUN,1000).project(camera);
 camera.getWorldDirection(_cf);const facing=_cf.dot(SUN);
 const on=_sp.z<1&&facing>0?(1-smooth(.15,.9,Math.max(Math.abs(_sp.x),Math.abs(_sp.y))-1)):0;
 sunVis=on*smooth(.0,.5,facing);
 const ru=rayPrepMat.uniforms,sx=_sp.x*.5+.5,sy=_sp.y*.5+.5;ru.uSun.value.set(sx,sy);rayBlurMat.uniforms.uSun.value.set(sx,sy);ru.uAspect.value=camera.aspect;
}

function renderWorld(dt){
 const cu=compMat.uniforms;
 const ac=renderer.autoClear;renderer.autoClear=false;
 // particle uniforms that follow the camera / shadow
 const H=fxU.uRes.value.y;fxU.uScale.value=H/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)));
 fxU.uNear.value=aoBlurMat.uniforms.uNear.value=camera.near;fxU.uFar.value=aoBlurMat.uniforms.uFar.value=camera.far;fxU.uFogD.value=scene.fog?scene.fog.density:0;
 // 1. scene (shadow maps render inside this call)
 renderer.setRenderTarget(rtScene);renderer.setClearColor(0x000000,1);renderer.clear(true,true,false);renderer.render(scene,camera);
 if(sun.shadow.map){fxU.uShadow.value=sun.shadow.map.texture;fxU.uShadowM.value.copy(sun.shadow.matrix);fxU.uHasShadow.value=1;}
 // 2. SSAO (desktop, half res)
 const aoOn=post.ao&&Q.ssao&&quality>.7;
 if(Q.ssao){if(aoOn){aoMat.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);aoMat.uniforms.uProjY.value=camera.projectionMatrix.elements[5];
   pass(aoMat,rtAO);pass(aoBlurMat,rtAO2);cu.uAO.value=.8;}else cu.uAO.value=0;}
 // 3. god rays (quarter res)
 const rays=post.rays&&sunVis>.01;
 if(rays){pass(rayPrepMat,rtR1);rayBlurMat.uniforms.tSrc.value=rtR1.texture;rayBlurMat.uniforms.uLen.value=.92;pass(rayBlurMat,rtR2);
  rayBlurMat.uniforms.tSrc.value=rtR2.texture;rayBlurMat.uniforms.uLen.value=.3;pass(rayBlurMat,rtR1);
  cu.uRayCol.value.copy(SUN_RGB).multiplyScalar(.38*sunVis);}
 else{renderer.setRenderTarget(rtR1);renderer.setClearColor(0,0);renderer.clear(true,false,false);}
 // 4. particles (half res, premultiplied)
 renderer.setRenderTarget(rtFx);renderer.setClearColor(0x000000,0);renderer.clear(true,false,false);renderer.render(fxScene,camera);
 // 5. bloom
 for(let i=0;i<rtBloom.length;i++){const src=i===0?rtScene:rtBloom[i-1];bloomDown.uniforms.tSrc.value=src.texture;bloomDown.uniforms.uTexel.value.set(1/src.width,1/src.height);
  bloomDown.uniforms.uFirst.value=i===0?1:0;pass(bloomDown,rtBloom[i]);}
 for(let i=rtBloom.length-1;i>0;i--){const src=rtBloom[i];bloomUp.uniforms.tSrc.value=src.texture;bloomUp.uniforms.uTexel.value.set(1/src.width,1/src.height);pass(bloomUp,rtBloom[i-1]);}
 // 6. composite (+ FXAA on mobile)
 cu.uSpeed.value=speedK*(fpMode?1.2:1);cu.uCA.value=speedK;cu.uBloom.value=post.bloom;cu.uExposure.value=post.exposure;cu.uVig.value=.42+speedK*.25;cu.uTime.value=(cu.uTime.value+1)%64;
 if(Q.fxaa){pass(compMat,rtLDR);pass(fxaaMat,null);}else pass(compMat,null);
 renderer.autoClear=ac;
}
export {renderer,scene,camera,sun,hemi,sky,skyU,ranges,post,resize,dust,debris,Particles,SOFT,ATMOS_GLSL,renderWorld,fxScene};
