---
"create-guren-app": patch
---

Ship `.guren/*.gen.ts` files that match what codegen writes

A freshly scaffolded default, blog or worker app committed an
`api-client.gen.ts` older than the generator, and no `translations.gen.ts`
although the app has `lang/`. The first `bun run dev` rewrote one and created
the other, so the git tree was dirty before anything had been edited, and the
next `git add -A` swept both into an unrelated commit. The templates now carry
the current output, including `translations.gen.ts`.
