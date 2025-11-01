# @guren/inertia-client — AI Coding Notes

## Purpose
- Browser-side bootstrap for Inertia + React, consumed by `@guren/server` dev assets and hydrated apps.

## Structure
- Single entry `src/app.tsx` exporting `startInertiaClient`.
- Built ESM bundle served from `/vendor/inertia-client.tsx` in dev.

## Conventions
- Keep dependencies lean (React, ReactDOM, @inertiajs/react). Avoid importing server-only code.
- Prefer hooks-friendly API surface; stick to default ESM exports.

## Build
- Build with `bun run --cwd packages/inertia-client build` (tsup config in repo).
- Update `package.json` if additional entry points are introduced; ensure CDN-based consumers can tree-shake.
