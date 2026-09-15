---
'@guren/cli': minor
---

`guren check` reads an app's configuration by importing it (RFC 0027 §6). A definition is data whose `resolve` is a pure function of the validated environment, so the CLI computes a config without booting the app.

Only a file that reads as a definition, or one the entry's `createApp({ config: [...] })` array lists, is imported: the rest of `config/` is the app's own module, and running its top-level code is not this check's business. A config built from a key the environment does not set is marked unverified rather than kept, since it holds the redacted placeholder, and any value a `.secret()` variable holds is redacted out of an error the import or `resolve()` raised.

Two wiring results come with it, both judged only against that array: `config-unwired` warns about a definition the array does not list, which binds nothing while the app looks configured; `config-not-a-definition` fails a file the array lists whose default export is not a definition, which the boot dies on. A file that could not be imported warns instead. An array this cannot read whole, such as `config: definitions` or one holding a spread, reports nothing.
