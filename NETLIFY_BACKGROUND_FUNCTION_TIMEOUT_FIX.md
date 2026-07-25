# Spot search / tripod candidates return nothing in production — root cause and fix

## Symptom
- スポット検索を実行しても最新版で結果がヒットしない。
- 被写体ピンを置いても三脚候補点が出てこない。
- ローカル開発 (`npm run dev`) では問題なく動く。

## Root cause
`netlify/functions/spot-search-start.ts` runs the *entire* search pipeline
(`await runSpotSearchJob(job)`, which internally does GSI elevation lookups,
terrain occlusion checks, and the full tripod-candidate search) inside a
single request/response cycle, and relies on `config.background = true` to
get Netlify's extended (up to 15 minute) execution budget instead of the
default synchronous function timeout (~10–26s).

Netlify's Background Functions are only recognized when the **function file
name ends in `-background`**. A `background: true` field in the exported
`config` object of a normally-named function is not sufficient on its own —
the platform still treats a file named `spot-search-start.ts` as a regular,
short-timeout function. Any real search (which needs several DEM/terrain
fetches per candidate direction) takes far longer than a regular function's
timeout, so the invocation is killed mid-flight before `updateSpotSearchJob`
ever writes a `running`/`awaiting-3d` state. The client then either sees a
generic gateway/timeout error on `/api/spot-search-start`, or polls
`/api/spot-search-status` for a job that never advances past `queued` —
which surfaces to the user as "検索がヒットしない". The same long-running
path also computes the tripod candidates, so they never appear either.

(`netlify/functions/spot-search-background.ts` was a leftover, unused
duplicate of this handler — it was never called from `src/`, so it provided
no actual background execution path.)

## Fix
- Renamed `netlify/functions/spot-search-start.ts` →
  `netlify/functions/spot-search-start-background.ts` so Netlify's build step
  registers it as a genuine Background Function (15 minute budget, immediate
  202 response to the caller) regardless of the `config.background` field.
  The public URL is unchanged (`config.path` still pins it to
  `/api/spot-search-start`), so no frontend changes were needed.
- Removed the unused `spot-search-background.ts` duplicate and its now
  meaningless `/api/spot-search-background` redirect.
- Updated the `/api/spot-search-start` redirect in `netlify.toml` to point at
  the renamed function file.

## Verification suggested after deploy
1. Run a spot search in production and confirm `/api/spot-search-start`
   returns `202` immediately (not a 502/504 after ~10–25s).
2. Confirm `/api/spot-search-status` progresses through
   `queued` → `running` → `awaiting-3d` instead of staying on `queued`.
3. Confirm tripod candidate pins appear once status reaches `awaiting-3d`.
