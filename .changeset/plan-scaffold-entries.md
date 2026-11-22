---
"@guren/cli": minor
---

Add `plan:scaffold --entries`. From the http step that owns a plan's added providers and env keys, it writes what the task's commands left missing: each provider as an empty class under `app/Providers/`, registered in `createApp()`, and each key in `config/env.ts` and `.env.example`, declared as `guren plugin` declares a manifest key. A provider or key a command already wrote is left as it is, and a config entry is never written. `plan:next` names the command while something is missing.
