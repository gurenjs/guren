---
'@guren/plugin-mcp': patch
---

Read the `buildToolRequest` failure messages from the shared `describeBuildFailure` instead of restating them.

No message changes. The wording used to be duplicated byte-for-byte in the WebMCP client, held in sync by a comment; it now has one definition in `@guren/core/agent`, so the two surfaces cannot drift apart.

`gurenPlugin.compatibility` rises to `">=1.13.0 <2.0.0"` — the plugin now imports a core export that first ships in 1.13.0, and the claim is what makes `guren plugin` refuse a core that lacks it. The `@guren/core` dependency range stays at the workspace version on purpose; `changeset version` raises the published floor.
