---
"@guren/cli": patch
---

`make:feature` labels every form field on the New and Edit pages it writes. Text, textarea, number, date and json fields each get a visible `<label>` tied to the control by an id from React's `useId()`, in place of the placeholder that was their only name, so screen readers announce the field and Playwright's `getByLabel()` finds it. Checkboxes were already wrapped in their label and are unchanged. `--prototype` pages get the same forms.
