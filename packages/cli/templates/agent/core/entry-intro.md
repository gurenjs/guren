# __APP_TITLE__

## Overview

A fullstack TypeScript application built with the Guren framework (Laravel-inspired, running on Bun).

## AI Agents: Start Here

Before exploring `node_modules`, use the built-in introspection commands:

```bash
bunx guren context         # project map: models, routes, controllers, pages (add --json for JSON)
bunx guren context User    # everything about one entity: model, routes, pages, linked docs — start entity work here
bunx guren check           # validate route ↔ controller ↔ page consistency, doc links, and spec freshness — run after changes
bunx guren docs:graph --path <file>  # which docs govern this file, which spec views derive from it — ask BEFORE renaming/moving
bunx guren codegen         # regenerate .guren/*.gen.ts typed manifests (also runs via `bun run dev`)
bunx guren spec:generate   # regenerate docs/spec/ views (ER, domain, screens, modules) after schema/model/route changes
bunx guren make:adr "..."  # record an architecture decision under docs/adr/ (--entity <Model> links it)
```
