import test from 'node:test';
import assert from 'node:assert/strict';

function ml(samples,width,height,radius=1){
  const r=new Float64Array(width*height);
  for(let y=1;y<height-1;y++) for(let x=1;x<width-1;x++){
    const i=y*width+x;
    r[i]=Math.abs(samples[i-1]-2*samples[i]+samples[i+1])+
         Math.abs(samples[i-width]-2*samples[i]+samples[i+width]);
  }
  const out=new Float64Array(width*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++){
    let sum=0,n=0;
    for(let yy=Math.max(0,y-radius);yy<=Math.min(height-1,y+radius);yy++)
      for(let xx=Math.max(0,x-radius);xx<=Math.min(width-1,x+radius);xx++){
        sum+=r[yy*width+xx]; n++;
      }
    out[y*width+x]=sum/n;
  }
  return out;
}

test('modified Laplacian is zero on constant field',()=>{
  const out=ml(new Float64Array(49).fill(0.5),7,7);
  for(const v of out) assert.equal(v,0);
});
test('modified Laplacian responds to a hard edge',()=>{
  const s=new Float64Array(49);
  for(let y=0;y<7;y++) for(let x=0;x<7;x++) s[y*7+x]=x<3?0:1;
  assert.ok(ml(s,7,7)[24]>0);
});
