---
'@guren/cli': minor
---

`guren codegen` types `appTools()` for an app depending on `@guren/plugin-ai` (RFC 0029 §11). `.guren/agents.gen.ts` gains `AgentToolInputTypes`, each tool's arguments rendered from its route's Zod contracts over the merged input schema (a property the extractor cannot render is `unknown`), and a `declare module '@guren/plugin-ai'` augmentation of `AppAgentTools` carrying each tool's input and output. An app without the plugin gets the same file as before.
