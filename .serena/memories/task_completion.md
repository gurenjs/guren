Before requesting review or merging:
1. Ensure Dockerized Postgres is running if changes depend on DB, otherwise tear down with `bun run db:down`.
2. Run `bun run build` at repo root to compile all packages.
3. Run the full test suite (`bun run test`) or at minimum `bun run test:bun` and `bun run test:examples` relevant to touched areas.
4. Execute `bun run typecheck` (and `bun run --cwd examples/blog typecheck` if frontend changes) to keep TypeScript definitions healthy.
5. Update docs/README/changesets if behaviour changes; follow Conventional Commits for versioning.
6. For example app UI/server changes, rebuild blog client+SSR bundles before production deploys (`bunx vite build` + `bunx vite build --ssr`).