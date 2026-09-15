---
'@guren/plugin-lambda': patch
---

`GurenLambdaApp` no longer adds a fixed `/assets/*` CloudFront behavior. The staged `.lambda/assets` directory decides: one built by a `@guren/core` that still stages a top-level `assets/` gets `/assets/*` from the per-root-entry behaviors, as its HTML needs, and one without it no longer spends one of CloudFront's 25 default cache behaviors on a path nothing requests.
