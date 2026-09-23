---
'@guren/cli': minor
---

`guren check`'s config wiring reads `defineModule({ config })` (RFC 0002). A definition under `modules/<name>/config/` that no array lists is reported as `config-unwired` with its module's descriptor as the place to list it, a module's list counts as wiring only while `createApp({ modules })` lists that module, and a key two read arrays define is a `config-duplicate-key` failure, which the boot would refuse. A module config array this cannot read whole (not a literal, a spread in the descriptor) reports nothing, as the root array already did.
