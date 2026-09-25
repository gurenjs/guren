---
'@guren/cli': patch
---

`guren codegen` binds each imported name once in `.guren/data.gen.ts`. Two resources importing the same type in different statement shapes (`import type { PostRecord }` in one, `import { type PostRecord }` in the other, or a list one of them shares) each contributed an import line, and the second was a duplicate identifier `bun run typecheck` rejected. The first import of a name is kept as written and later ones are dropped; a statement partly bound already is re-emitted with the rest. A resource importing a name the block already binds from another module is emitted as the `import('…')` reference to its own exported payload, the fallback an uncopyable body already takes; when the payload is not exported it is omitted with a warning naming both files.
