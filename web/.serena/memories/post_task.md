# Post-Task Checklist
- Run relevant checks: typically `bun run build` for bundle sanity; `bun run routes:types` if routes changed; DB commands only if schema/migrations touched. Add tests via @guren/testing/vitest when altering logic.
- Verify dev server starts: `bun run dev` (or `bun run dev:server`) if runtime behavior touched.
- Ensure .env is configured (copy .env.example) when instructions require environment.
- Keep git changes minimal; follow Conventional Commits for commit messages if committing.
- Avoid reverting user changes; respect existing modifications per instructions.
- Default to ASCII; add concise comments only when necessary for clarity.