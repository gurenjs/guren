## Session Workflow

Nothing runs these steps for you automatically (hook support varies by agent),
so make them part of your loop:

1. **At session start**, run `bunx guren context` and read the output. It ends
   with a "Guren API Signatures" digest of the ORM, controller, and testing
   APIs — read it before writing any code. With the MCP server connected, the
   `guren_get_context` tool returns the same map.
2. **After editing** routes, controllers, models, `db/schema.ts`, or pages,
   run `bunx guren check` and fix what it reports before moving on. With an
   `.oxlintrc.json` in the app (`bunx guren add lint`), run `bun run lint` on
   what you edited as well; its warnings are for you to act on.
3. Framework-managed files (`.agents/rules/`, `.agents/skills/`) can be
   refreshed anytime with `bunx guren agent:sync`.

Reusable skills (SKILL.md, the Agent Skills format) live in
`.agents/skills/` — agents that support the standard discover them there
automatically.

Detailed, verified API rules live in `.agents/rules/*.md`; each file's `globs`
frontmatter states which paths it covers — read the matching rule before
editing those paths.
