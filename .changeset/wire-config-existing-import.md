---
'@guren/cli': patch
---

Blueprints that register a config definition or a scaffolded provider in `createApp()` no longer duplicate one the entry already imports. `guren add cache` against an entry holding `import cache from '../config/cache'` (no extension) added a second `import cache` line, a duplicate declaration the app could not load; one importing it as `import cacheConfig from '@/config/cache.js'` gained a second entry and a second definition for the `cache` key, which `createApp()` refuses at boot. The existing binding is now registered under its own name, whatever the specifier spells.
