---
"@guren/cli": patch
---

The agent harness's `guren-api` skill names where a `Field` reads its label from (`fields.<route>.<name>.label`, then `fields.<name>.label`, then the field name) and `hasTranslation()`.
