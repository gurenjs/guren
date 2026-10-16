---
"@guren/cli": patch
"create-guren-app": patch
---

The profile page `make:auth` writes ties each label to its input with `useId()`, as the sign-in and registration pages already did, and so do the blog starter's profile and post forms. Screen readers now announce each field by name, and Playwright's `getByLabel()` finds it. The read-only email shown under `--oauth` without `--verify` is no longer a `<label>`, since there is no control for it to label.
