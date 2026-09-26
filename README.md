<p align="center">
  <a href="https://guren.dev/">
    <img src="web/public/logo.svg" alt="Guren" width="72">
  </a>
</p>

<h1 align="center">Guren</h1>

<p align="center">
  <strong>Laravel-style fullstack TypeScript, on Bun.</strong><br>
  Controllers, models and React pages wired together with types, built so your coding agent can work on it too.
</p>

<p align="center">
  <a href="https://guren.dev/">Docs</a> ·
  <a href="https://guren.dev/docs/guides/why-guren">Why Guren</a> ·
  <a href="./examples/blog">Example app</a> ·
  <a href="https://github.com/gurenjs/guren/discussions">Discussions</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://x.com/gurenjs"><img src="https://img.shields.io/badge/follow-%40gurenjs-black?logo=x" alt="X"></a>
  <a href="https://github.com/sponsors/7nohe"><img src="https://img.shields.io/github/sponsors/7nohe?logo=githubsponsors" alt="GitHub Sponsors"></a>
</p>

https://github.com/user-attachments/assets/f27c4355-8a47-4e35-a128-0b1027ebc390

## Quick start

```bash
bunx create-guren-app my-app --auth
cd my-app
bun run db:migrate && bun run db:seed
bun run dev
```

Open http://localhost:3333 and sign in with `demo@example.com` / `secret`. SQLite is the default, so there is nothing else to set up.

## Why Guren

- **Laravel's structure, TypeScript's types.** Routes, controllers, models and migrations where you expect them, typed from the route to the React component.
- **No API layer.** Inertia.js passes controller data straight to React pages.
- **Batteries included.** Auth, queues, mail, cache, storage, notifications, real-time and scheduling are one command away.
- **Agent-ready.** Every app ships a harness for coding agents (`CLAUDE.md`, rules, hooks) and commands that check their work.
- **Fast, and deploys anywhere.** Runs on Bun; ships to Cloudflare Workers, Vercel or AWS Lambda.
- **Secure by default.** CSRF, security headers and same-origin CORS are on before you configure anything.

## Add what you need

```bash
bunx guren add auth
bunx guren add resource posts --fields "title:string,body:text"
bunx guren add notifications
bunx guren add storage
bunx guren add broadcasting
```

Then `bun run codegen` to refresh the types, and `bun run build` when you ship. See the [CLI guide](https://guren.dev/docs/guides/cli) for everything `guren add` can install.

## Numbers

- **Agents:** with the bundled harness, Sonnet 5 passed 60/60 tasks (58/60 without) at 25% lower cost. [Agents on Guren](https://github.com/gurenjs/agents-on-guren)
- **Speed:** 2.3× the throughput of an equivalent Node.js MVC stack on SSR pages, 3.5× on JSON. [Benchmark](https://github.com/gurenjs/framework-comparison/blob/main/BENCHMARK.md)

## Requirements

[Bun](https://bun.sh/) 1.4.2. Docker only if you want PostgreSQL or MySQL instead of SQLite.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). If Guren helps you, consider [sponsoring](https://github.com/sponsors/7nohe).

v2 is stable: breaking changes only land in major releases ([release policy](docs/en/guides/release-policy.md)).

## License

[MIT](./LICENSE)
