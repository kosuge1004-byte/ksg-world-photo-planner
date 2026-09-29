/**
 * サーバーとクライアントで同じ対象リストを使用する。
 * 実データ公開前に次の3工程を通すこと。
 * 1. npm run local-dem:precompute-landmarks
 * 2. npm run local-dem:audit-precomputed
 * 3. npm run r2:publish-precomputed -- --execute
 */
export {
  PRECOMPUTED_BEARING_PROFILE_TARGETS,
  findPrecomputedBearingProfileTarget,
  type PrecomputedBearingProfileTarget,
} from "../src/data/precomputedBearingProfileTargets.ts";
