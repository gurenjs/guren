---
"web": patch
---

Publish the site's own docs graph at `guren.dev/_guren/docs` instead of the blog example's. `web/docs/` now holds ADRs for the decisions behind the site (Workers with D1, docs rendered at build time, cookie-less analytics, the single allowlisted admin, sessions and OAuth state in D1, posts rendered when saved) and the generated spec views, which CI checks for drift with `check --spec` and `check --docs`. The docs store now skips a `docs/` directory with no locale directory, so `web/docs` is not taken for the site's guides.
