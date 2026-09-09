---
"@guren/inertia-client": patch
---

`renderInertiaServer()` reports `pageEmbedded: true`: Inertia's `createInertiaApp` writes the page into the body's `data-page` element itself, and saying so lets `@guren/server` skip appending a second copy.
