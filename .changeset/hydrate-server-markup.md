---
'@guren/inertia-client': patch
---

`startInertiaClient()` hydrates a page the server rendered instead of replacing it, as Inertia's own default does, and `useField` takes in what was typed into a control before hydration. Text, numbers, checkboxes, selects, dates and files filled in before the client loaded are kept and submitted, where they used to be wiped.
