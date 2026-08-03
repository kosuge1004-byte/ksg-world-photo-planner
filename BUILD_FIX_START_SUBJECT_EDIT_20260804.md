# Cloudflare build fix: unused startSubjectEdit

- Removed the unused `startSubjectEdit` function from `src/App.tsx`.
- The function became unreachable after the pin-menu command "3Dで被写体を指定" was removed.
- Existing subject pin placement, subject Google Maps handoff, and the remaining subject-edit overlay code were not modified.
- `npm ci` could not complete in the inspection environment because its internal npm mirror returned 404 for `youch-core@0.3.3`; therefore a full local production build was not executable here.
