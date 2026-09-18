---
"@guren/cli": patch
---

The agent harness ships an `ai-agent` skill: how to write an in-process agent with `@guren/plugin-ai`, when `appTools()` is the right tool and a local `tool()` is not, and the `fakeAi()` test that proves the wiring. `guren agent:sync` installs it, and `--prune` now claims the `ai-agent` skill directory by name.
