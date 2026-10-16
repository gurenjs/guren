---
"@guren/cli": patch
"create-guren-app": patch
---

The profile page `make:auth` writes (and the blog starter's) ties each label to its input with `useId()`, as the sign-in and registration pages already did. Screen readers now announce the Name, Email and New password fields by name, and Playwright's `getByLabel()` finds them. The read-only email shown under `--oauth` is no longer a `<label>`, since there is no control for it to label.
