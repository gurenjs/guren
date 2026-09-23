---
'@guren/cli': minor
---

`guren check`'s config wiring reads `defineModule({ config })` (RFC 0002). A definition under `modules/<name>/config/` that no array lists is reported as `config-unwired` with its module's descriptor as the place to list it, a module's list counts as wiring only while `createApp({ modules })` lists that module, and a key two read arrays define is a `config-duplicate-key` failure, which the boot would refuse. For a module `createApp({ modules })` mounts or may mount, a config array this cannot read whole (not a literal, a spread in the descriptor, a descriptor that is not a `defineModule({ … })` call, or a `createApp({ modules })` it cannot trace, including options spread where `modules` may hide) reports nothing for the whole app, as an unreadable root array already did, since such an array may list any file.
