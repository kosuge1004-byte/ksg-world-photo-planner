import fs from 'node:fs';
const s=fs.readFileSync('src/components/PreviewGestureLayer.tsx','utf8');
const checks=[
 ['long press duration exists',s.includes('LONG_PRESS_DURATION_MS = 550')],
 ['long press movement tolerance exists',s.includes('LONG_PRESS_MAX_MOVEMENT_PX = 14')],
 ['normal subject placement schedules long press',s.includes('scheduleLongPress')],
 ['movement cancels long press',s.includes('cancelLongPress()')],
 ['explicit subject mode is retained',s.includes('subjectPicking')],
 ['measurement mode is retained',s.includes('measuring') && s.includes('onMeasureTap')],
 ['pinch zoom remains',s.includes('pinch') || s.includes('touchDistance')],
];
let n=0; for(const [m,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${m}`); if(!ok)n++;} if(n)process.exit(1);
