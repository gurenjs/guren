---
"@guren/cli": patch
---

Let `agent:sync --prune` remove a stale managed file whose name differs from a planned one only by case.

The stale scan compared paths case-insensitively, so that a case-preserving filesystem — where the write loop refreshes a planned file through a differently-cased directory entry it found on disk — would not classify the file it had just written as stale. On a case-sensitive filesystem those two names are two separate files: after a rename, `.claude/rules/ORM-MODELS.md` and `.claude/rules/orm-models.md` both exist, and the lowercased comparison hid the genuinely stale one from prune permanently.

The scan now matches exact paths first, and for a case-only mismatch spares the entry only when it and the planned path are the same file on disk (same device and inode). A filesystem that cannot answer that question leaves the entry alone — neither reported nor deleted — rather than spending an irreversible delete on a claim it could not establish.
