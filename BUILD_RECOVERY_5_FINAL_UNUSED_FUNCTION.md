# Build Recovery 5 - Final unused function cleanup

## Change

Removed the unused `pointsMatch` helper from `src/App.tsx`.

## Reason

Netlify TypeScript build reported TS6133 because the helper was declared but never read.

## Runtime impact

None. The function had no call sites.

## Verification status

The source was searched before removal and no references to `pointsMatch` were found.
A full Netlify build must still be run to confirm that no additional errors are revealed after this final TypeScript error.
