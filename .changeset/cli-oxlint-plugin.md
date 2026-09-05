---
"@guren/cli": minor
---

Publish the `guren` oxlint plugin as `@guren/cli/oxlint`: `guren/await-async-assertion` (a bare `expect(...).rejects` / `.resolves` statement that can never fail its test) and the `guren/comment-*` rules (block length, banners, step labels, change-history wording, `@param` tags that restate the name). Name it from an app's `.oxlintrc.json` as `"jsPlugins": ["@guren/cli/oxlint"]`.
