---
'@guren/inertia-client': patch
---

`startInertiaClient()` hydrates a page the server rendered instead of replacing it, as Inertia's own default setup does. Just before hydrating it records each form control a reader changed (compared with what its markup describes), and `useField` takes that value through the control's own `onChange` when the control hydrates. Text, textareas, numbers, checkboxes, selects, dates and files filled in before the client loaded are kept and submitted; a control nobody touched, one an app renders its own way, and every client-rendered one keep their state. A custom `setup` still mounts however it chooses.
