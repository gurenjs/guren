---
'@guren/server': patch
---

Approval fingerprints are now an HMAC-SHA256 under a key derived from `APP_KEY`, so someone who can read the approval store can no longer test guesses for a redacted argument (a PIN, a short password) against the stored fingerprint. An app without a valid `APP_KEY` keeps the plain SHA-256 and works as before. Lookups also try each `APP_PREVIOUS_KEYS` entry and the plain hash, so requests filed before the upgrade or a key rotation still match; each extra key costs one more `findMatch` on a call the store has no record for. Rotating or removing `APP_KEY` without listing the old key in `APP_PREVIOUS_KEYS` leaves live approvals unmatched.
