---
'@guren/cli': patch
---

`make:feature` New and Edit pages show each field's validation error under its control and mark the control with `aria-invalid` and `aria-describedby`, including the json field's "not valid JSON" message. The generated `edit()` action no longer passes `errors: {}`, which overrode the flashed validation errors so the Edit page never received them, and the Edit page's unused `errors` prop is gone.
