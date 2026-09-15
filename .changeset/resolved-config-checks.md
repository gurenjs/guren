---
'@guren/cli': minor
---

`guren check` reads an app's configuration by importing it (RFC 0027 §6). A definition is data whose `resolve` is a pure function of the validated environment, so the CLI computes a config without booting the app, once per app root.

Two wiring results come with it, both content-activated and judged only against the entry's `createApp({ config: [...] })` array: `config-unwired` warns about a `config/<key>.ts` definition the array does not list, which binds nothing while looking configured; `config-not-a-definition` fails a file the array lists whose default export is not a definition, which the boot dies on. An array the scan cannot read, such as `config: definitions`, reports nothing.
