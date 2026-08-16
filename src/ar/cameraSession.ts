export type ArWebCameraState = {
  stream: MediaStream;
  track: MediaStreamTrack;
  label: string;
  width: number | null;
  height: number | null;
  facingMode: string | null;
  zoom: number | null;
};

export async function startEnvironmentCamera(): Promise<ArWebCameraState> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("この環境ではカメラ映像を利用できません");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((item) => item.stop());
    throw new Error("背面カメラを開始できませんでした");
  }
  const settings = track.getSettings();
  const extended = settings as MediaTrackSettings & { zoom?: number };

  return {
    stream,
    track,
    label: track.label || "",
    width: typeof settings.width === "number" ? settings.width : null,
    height: typeof settings.height === "number" ? settings.height : null,
    facingMode: typeof settings.facingMode === "string" ? settings.facingMode : null,
    zoom: typeof extended.zoom === "number" ? extended.zoom : null,
  };
}

export function stopCameraStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}
