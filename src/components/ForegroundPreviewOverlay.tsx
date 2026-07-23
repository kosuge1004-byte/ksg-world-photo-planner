import { sensorDimensionsMm } from "../cesium/camera";
import type { CameraSettings } from "../types/camera";
import type { ForegroundObject } from "../types/foreground";
import type { GroundPoint } from "../types/points";

type Props = {
  object: ForegroundObject | null;
  tripod: GroundPoint | null;
  subject: GroundPoint | null;
  camera: CameraSettings;
  aspectRatio: number;
};

const EARTH_RADIUS = 6371008.8;
function distanceAndBearing(a: {latitude:number;longitude:number}, b:{latitude:number;longitude:number}) {
  const p1=a.latitude*Math.PI/180,p2=b.latitude*Math.PI/180;
  const dl=(b.longitude-a.longitude)*Math.PI/180;
  const dp=(b.latitude-a.latitude)*Math.PI/180;
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  const distance=2*EARTH_RADIUS*Math.asin(Math.min(1,Math.sqrt(h)));
  const y=Math.sin(dl)*Math.cos(p2);
  const x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return {distance,bearing:Math.atan2(y,x)};
}
function normalizeAngle(v:number){ while(v>Math.PI)v-=Math.PI*2; while(v< -Math.PI)v+=Math.PI*2; return v; }

export function ForegroundPreviewOverlay({object,tripod,subject,camera,aspectRatio}:Props){
  if(!object?.enabled||!tripod||!subject||!Number.isFinite(object.groundHeightMeters)) return null;
  const toSubject=distanceAndBearing(tripod,subject);
  const toObject=distanceAndBearing(tripod,object);
  if(toObject.distance<0.2) return null;
  const sensor=sensorDimensionsMm(aspectRatio);
  const hFov=2*Math.atan(sensor.width/(2*camera.focalLengthMm));
  const vFov=2*Math.atan(sensor.height/(2*camera.focalLengthMm));
  const cameraHeight=tripod.height+camera.lensCenterHeightMeters;
  const subjectAlt=Math.atan2(subject.height-cameraHeight,Math.max(0.1,toSubject.distance));
  const objectGroundHeight=object.groundHeightMeters as number;
  const baseAlt=Math.atan2(objectGroundHeight-cameraHeight,Math.max(0.1,toObject.distance));
  const topAlt=Math.atan2(objectGroundHeight+object.heightCm/100-cameraHeight,Math.max(0.1,toObject.distance));
  const x=50+normalizeAngle(toObject.bearing-toSubject.bearing)/hFov*100;
  const yTop=50-(topAlt-subjectAlt)/vFov*100;
  const yBase=50-(baseAlt-subjectAlt)/vFov*100;
  const height=yBase-yTop;
  if(!Number.isFinite(height)||height<=0.02||x< -20||x>120||yBase< -20||yTop>120) return null;
  return <div className="foreground-preview-object" style={{left:`${x}%`,top:`${yTop}%`,height:`${height}%`,width:`${height*.4}%`}} aria-label={`人物 ${object.heightCm}cm`}>
    <svg viewBox="0 0 80 200" preserveAspectRatio="xMidYMax meet"><circle cx="40" cy="22" r="18"/><path d="M26 45 Q40 37 54 45 L62 112 53 112 58 194 43 194 40 126 37 194 22 194 27 112 18 112Z"/></svg>
  </div>;
}
