import test from 'node:test';
import assert from 'node:assert/strict';

function fit(matches){
  let rx=0,ry=0,sx=0,sy=0;
  for(const m of matches){rx+=m.rx;ry+=m.ry;sx+=m.sx;sy+=m.sy;}
  rx/=matches.length; ry/=matches.length; sx/=matches.length; sy/=matches.length;
  let a=0,b=0,e=0;
  for(const m of matches){
    const x=m.rx-rx,y=m.ry-ry,u=m.sx-sx,v=m.sy-sy;
    a+=x*u+y*v; b+=x*v-y*u; e+=x*x+y*y;
  }
  return {scale:Math.hypot(a,b)/e,rot:Math.atan2(b,a)};
}

test('scaled-similarity fit recovers breathing magnification and rotation',()=>{
  const scale=1.025, ang=0.01, c=Math.cos(ang),s=Math.sin(ang), tx=3,ty=-2;
  const pts=[[0,0],[100,0],[0,100],[100,100],[55,23]];
  const matches=pts.map(([x,y])=>({
    rx:x,ry:y,
    sx:scale*(c*x-s*y)+tx,
    sy:scale*(s*x+c*y)+ty
  }));
  const r=fit(matches);
  assert.ok(Math.abs(r.scale-scale)<1e-12);
  assert.ok(Math.abs(r.rot-ang)<1e-12);
});
