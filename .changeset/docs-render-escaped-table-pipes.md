---
"@guren/cli": patch
---

Keep an escaped pipe inside a docs table cell instead of splitting on it. `spec:generate` writes TypeScript unions as `A \| B`, so the docs viewer rendered those rows with one cell too many and a stray backslash — a `screens.md` Props column was the common case.
