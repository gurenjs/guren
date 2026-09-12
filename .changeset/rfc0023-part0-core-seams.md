---
"@guren/core": minor
---

Re-export the RFC 0023 Part 0 seams from `@guren/server` (`getRequestContainer`,
`defaultApplication`, `defaultContainer`, `useAsDefaultApplication`,
`QueueManager.dispatch()`, `Worker { container }`, `createApp({ inertia })`),
and declare the `attachments` service binding `configureAttachments()` will
bind in Part 1.
