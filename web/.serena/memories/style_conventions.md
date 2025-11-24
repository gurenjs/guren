# Style & Conventions
- Language: TypeScript strict (ES2022, NodeNext modules), JSX via React 19; path alias `@/*` -> `app/*`.
- MVC pattern per AGENTS: routes defined with Route.get/group in routes/web.ts using [ControllerClass, 'method']; controllers extend base Controller and use this.inertia/json/redirect; models extend Model with static table and recordType typed from Drizzle schema; views under resources/js/pages mapped by Inertia component names.
- CLI conventions: citty for CLI parsing, consola for logging; keep runtime commands in packages/cli/src/runtime.ts (framework guidance).
- Docs/commits: follow Conventional Commits (see CONTRIBUTING reference in AGENTS); keep comments minimal/targeted; default to ASCII.
- Database: Drizzle ORM with Postgres default via config/database.ts; Docker compose service postgres on port 54322 with guren/guren creds.
- Assets: Inertia assets auto-configured via autoConfigureInertiaAssets; SSR entry at resources/js/ssr.tsx; Vite used for dev/build/preview.
- Testing: @guren/testing available; vitest runner referenced in AGENTS; no lint/format configs present, so keep existing style.