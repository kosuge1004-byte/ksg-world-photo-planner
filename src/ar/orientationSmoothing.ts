/**
 * スマホの方位・姿勢センサー(deviceorientation)は、端末を完全に静止させて
 * いても、電子コンパス・ジャイロの特性上、常に細かいノイズ(±数度程度の
 * 揺らぎ)を出し続ける。この生の値をそのまま3D表示の向きに反映すると、
 * カメラが静止していても3D表示だけが小刻みに振動して見える。
 *
 * 直前までの値と、今回センサーから届いた新しい値を「なめらかに混ぜ合わせる」
 * (指数移動平均)ことで、このノイズを抑える。実際に手でカメラを動かした時
 * には、新しい値の比重を高めに保つことで、違和感のない追従性を保つ。
 *
 * 角度(0〜360度、または-180〜180度)は、単純に数値の平均を取ると
 * 「359度」と「1度」の平均が「180度」になってしまう(本来は0度付近が
 * 正しい)。これを避けるため、角度をいったんベクトル(sin, cos)に変換して
 * から平均を取り、その後で角度に戻す。
 */

const SMOOTHING_FACTOR = 0.25; // 新しい値をどれだけ重視するか(0〜1)。小さいほど滑らかだが追従が遅れる。

type SmoothedAngleState = { sin: number; cos: number } | null;

function smoothAngleDegrees(
  previous: SmoothedAngleState,
  nextDegrees: number | null
): { state: SmoothedAngleState; valueDegrees: number | null } {
  if (nextDegrees === null || !Number.isFinite(nextDegrees)) {
    return { state: previous, valueDegrees: previous ? angleFromState(previous) : null };
  }
  const nextRad = (nextDegrees * Math.PI) / 180;
  const nextVector = { sin: Math.sin(nextRad), cos: Math.cos(nextRad) };
  if (!previous) {
    return { state: nextVector, valueDegrees: nextDegrees };
  }
  const blended = {
    sin: previous.sin * (1 - SMOOTHING_FACTOR) + nextVector.sin * SMOOTHING_FACTOR,
    cos: previous.cos * (1 - SMOOTHING_FACTOR) + nextVector.cos * SMOOTHING_FACTOR,
  };
  return { state: blended, valueDegrees: angleFromState(blended) };
}

function angleFromState(state: { sin: number; cos: number }): number {
  const degrees = (Math.atan2(state.sin, state.cos) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

export type ArOrientationSmoother = {
  /** 新しいセンサー値を渡し、平滑化済みの値を受け取る。 */
  smooth<T extends {
    headingDegrees: number | null;
    alphaDegrees: number | null;
    betaDegrees: number | null;
    gammaDegrees: number | null;
  }>(orientation: T): T;
};

/** 呼び出しのたびに内部状態を保持する、平滑化処理のインスタンスを作る。 */
export function createArOrientationSmoother(): ArOrientationSmoother {
  let headingState: SmoothedAngleState = null;
  let alphaState: SmoothedAngleState = null;
  let betaState: SmoothedAngleState = null;
  let gammaState: SmoothedAngleState = null;

  return {
    smooth(orientation) {
      const heading = smoothAngleDegrees(headingState, orientation.headingDegrees);
      const alpha = smoothAngleDegrees(alphaState, orientation.alphaDegrees);
      const beta = smoothAngleDegrees(betaState, orientation.betaDegrees);
      const gamma = smoothAngleDegrees(gammaState, orientation.gammaDegrees);
      headingState = heading.state;
      alphaState = alpha.state;
      betaState = beta.state;
      gammaState = gamma.state;
      return {
        ...orientation,
        headingDegrees: heading.valueDegrees,
        alphaDegrees: alpha.valueDegrees,
        betaDegrees: beta.valueDegrees,
        gammaDegrees: gamma.valueDegrees,
      };
    },
  };
}
