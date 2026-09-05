---
description: Comments — what a comment may carry, the size limits, and the oxlint rules that enforce the mechanical half
globs:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---

# Comments

Code shows *how*; a comment carries only what the code cannot: a non-obvious
constraint, a deliberate deviation, a pitfall or workaround, a unit or range, a
cross-file sync obligation, a measured number, an RFC or issue reference.

**Do not write**
- Narration of the next line or block (`// Check the user`, `// Return early`), a
  name or type restated, section banners (`// ---- helpers ----`), step labels
- Change history (`used to`, `previously`, `no longer`, "before this PR"): that is
  the commit message's job and it rots the day it lands
- `@param`/`@returns` that only repeat the name and type; `@example` that mirrors
  the signature
- JSDoc on a private or internal symbol that restates its name

**Size**: a comment block keeps to 5 lines of body, a module header to 8. If a
block needs more, it is holding more than one fact per line or explaining what
the code already says. Every distinct fact gets one line; prose around it goes.

**Keep verbatim**: tool directives (`@ts-expect-error`, `eslint-*`, `@vite-ignore`),
tags the framework reads (`@docs`, `@deprecated`, `guren-audit-ignore`), comments a
test reads as source text, and comments inside template literals (they are
generated output, not commentary).

```typescript
// Bad: restates the code
// Loop over the items and validate each one
for (const item of items) validate(item)

// Good: the one fact the code cannot show
// The API returns at most 100 rows per call regardless of `limit`.
for (const page of pages(100)) ...
```

## Enforcement

With `.oxlintrc.json` present (`bunx guren add lint` writes it), the
`guren/comment-*` oxlint rules check the mechanical half — block length, banners,
step labels, change-history wording, `@param` tags that restate the name — as
warnings, so `bun run lint` stays green on them; run it on the file you edited
and act on what it reports. A block that genuinely must exceed the limit (a test
pins its text, or every line is a measured fact) carries, on the line above it,
`// oxlint-disable-next-line guren/comment-length -- <reason>`.

Whether a comment merely narrates the code is a review judgment: check it on
every diff you review.
