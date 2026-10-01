import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function solve(matrix, vector) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    assert.ok(Math.abs(a[c][c]) >= 1e-12);
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = a[r][n];
    for (let c = r + 1; c < n; c++) v -= a[r][c] * x[c];
    x[r] = v / a[r][r];
  }
  return x;
}
const basis = (x,y) => [1,x,y,x*x,x*y,y*y];
function fit(points, values) {
  const m = Array.from({length:6},()=>Array(6).fill(0));
  const v = Array(6).fill(0);
  for (let i=0;i<points.length;i++) {
    const b=basis(points[i].x,points[i].y);
    for(let r=0;r<6;r++){v[r]+=b[r]*values[i];for(let c=0;c<6;c++)m[r][c]+=b[r]*b[c];}
  }
  return solve(m,v);
}
function median(xs){const s=[...xs].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function predict(c,p){const b=basis(p.x,p.y);return b.reduce((s,x,i)=>s+x*c[i],0);}

test('robust local residual refit rejects a sparse mismatched-star residual', () => {
  const pts=[]; const dx=[]; const dy=[];
  for(let y=-1;y<=1;y+=0.4) for(let x=-1;x<=1;x+=0.4){
    pts.push({x,y}); dx.push(0.18*x+0.05*y*y); dy.push(-0.12*y+0.03*x*y);
  }
  // One plausible star mismatch, far larger than the smooth optical residual.
  dx[7]+=2.4; dy[7]-=2.1;
  let cx=fit(pts,dx), cy=fit(pts,dy);
  const errors=pts.map((p,i)=>Math.hypot(dx[i]-predict(cx,p),dy[i]-predict(cy,p)));
  const center=median(errors); const mad=median(errors.map(e=>Math.abs(e-center)));
  const sigma=mad*1.4826;
  const tol=sigma>0?center+4.5*sigma:center+1e-9*Math.max(1,Math.abs(center));
  const keep=errors.map((e,i)=>e<=tol?i:-1).filter(i=>i>=0);
  assert.ok(keep.length >= 24);
  assert.ok(!keep.includes(7));
  cx=fit(keep.map(i=>pts[i]),keep.map(i=>dx[i]));
  cy=fit(keep.map(i=>pts[i]),keep.map(i=>dy[i]));
  assert.ok(Math.abs(predict(cx,{x:.75,y:-.55})-(0.18*.75+0.05*.55*.55)) < 1e-9);
  assert.ok(Math.abs(predict(cy,{x:.75,y:-.55})-(-0.12*-.55+0.03*.75*-.55)) < 1e-9);
});

test('highest-quality CFA path defaults local registration on after robustification', () => {
  const pipeline=fs.readFileSync('lib/core/session/cfa_drizzle_milky_way_pipeline.dart','utf8');
  const controller=fs.readFileSync('lib/core/background/background_stack_controller.dart','utf8');
  const worker=fs.readFileSync('lib/core/background/cfa_drizzle_background_worker.dart','utf8');
  const screen=fs.readFileSync('lib/features/milkyway/cfa_drizzle_milky_way_screen.dart','utf8');
  assert.match(pipeline,/bool enableLocalRegistration = true/);
  assert.match(controller,/bool enableLocalRegistration = true/);
  assert.match(worker,/enableLocalRegistration'\] as bool\? \?\? true/);
  assert.match(screen,/_enableLocalRegistration = true/);
  const local=fs.readFileSync('lib/core/registration/local_residual_correction.dart','utf8');
  assert.match(local,/_robustLocalResidualSurvivors/);
});
