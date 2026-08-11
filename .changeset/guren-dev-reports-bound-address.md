---
'@guren/cli': patch
---

Report the port `guren dev` actually bound, and stop swallowing `PORT=0`

`guren dev` carried its own copy of the entrypoint idiom this release removes
elsewhere: `Number.parseInt(process.env.PORT ?? '', 10) || 3333`, which turns
`PORT=0` into 3333 so "let the OS pick a free port" could not be expressed.

It also announced `http://${hostname}:${port}` from the values it *requested*,
without awaiting `listen()`. Those are not the bound values once the framework
walks past a busy port — so the one line telling you where to point your browser
was the line most likely to be wrong, and it printed the raw `0.0.0.0` wildcard
rather than something dialable. It now awaits `listen()` and reports the address
it returns, falling back to the requested values for an app whose installed
`@guren/server` predates that return value.
