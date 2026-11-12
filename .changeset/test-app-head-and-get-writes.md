---
"@guren/testing": minor
"@guren/cli": patch
---

`TestApp` gains `head(path)`. A `HEAD` request (uptime monitors, link checkers) runs the GET route's action and drops the body, so a view counter or a last-seen stamp written there counted requests nobody saw, and a test had no way to send one short of calling `app.fetch()` by hand.

The controllers guide and the agent harness's controller rule now say that a GET action also runs for `HEAD` and for an Inertia prefetch, and show the guard: `this.request.method === 'GET'` and no `Purpose: prefetch` header. The harness's review checklist asks for it, and the plan and impact scans read `http.head()` as a request to the GET route that answers it.
