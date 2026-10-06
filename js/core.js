// core.js — shared helpers for the browser modules. The mountain itself lives in terrainfn.js (no three.js, worker-safe).
import * as THREE from 'three';
export * from './terrainfn.js';
import {lerp} from './terrainfn.js';
export const damp=(a,b,k,dt)=>lerp(a,b,1-Math.exp(-k*dt));
export const wrapA=a=>{while(a>Math.PI)a-=2*Math.PI;while(a<-Math.PI)a+=2*Math.PI;return a;};
export const $=id=>document.getElementById(id);
export const store={get(k){try{return JSON.parse(localStorage.getItem('ridgeline.'+k));}catch(e){return null;}},set(k,v){try{localStorage.setItem('ridgeline.'+k,JSON.stringify(v));}catch(e){}}};
export const fmt=t=>{if(t==null||!isFinite(t))return'—';const m=Math.floor(t/60),s=t-m*60;return m+':'+(s<10?'0':'')+s.toFixed(2);};

// ───────────────────────── shared look constants
const isMobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||Math.min(innerWidth,innerHeight)<600;
const SUN=new THREE.Vector3(.72,.2,-.66).normalize();
const FOG_BASE=new THREE.Color().setRGB(.5,.56,.74);      // haze away from the sun (linear)
const FOG_SUN=new THREE.Vector3(1.6,.9,.45);              // haze toward the sun (linear)
const GLSL_NOISE=`
float hash12(vec2 p){p=mod(p,512.0);vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
 return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x),u.y);}
float fbm3(vec2 p){return vnoise(p)*.5+vnoise(p*2.03+7.1)*.25+vnoise(p*4.01+3.7)*.125;}`;

export {isMobile,SUN,FOG_BASE,FOG_SUN,GLSL_NOISE};
