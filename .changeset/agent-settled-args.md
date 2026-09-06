---
"@guren/plugin-agents": minor
---

Carry the parked call's arguments into `onToolApprovalSettled`. The approval queue holds no reversible copy of them by design, so an application that wanted to know *which* call a human answered had to keep a second `requestId` → arguments map beside the ledger's own. The ledger already decrypts the arguments to perform the retry; the hook now receives them as `args`, absent only for an `'unreadable'` row, where they are what could not be decrypted.
