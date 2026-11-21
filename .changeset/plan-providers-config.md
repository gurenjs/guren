---
'@guren/cli': minor
---

Implementation plans gain `providers` and `config` sections (RFC 0040 §5), which list what a change registers in the `providers` and `config` arrays of `createApp()`: a provider class at `app/Providers/<className>.ts` with its `purpose`, and a config definition at `config/<name>.ts`. Each entry is `add` or `existing`. A plan holding either section declares `planVersion` 2; a plan without them still reads as version 1 and keeps its hash, so an approved plan stays approved, and `plan:revise` moves a version 1 plan to 2 when it adds an entry. The checks judge each name against the application as they judge a class (an `add` that exists, an `existing` that is missing), and refuse two elements of one name and a provider an added policy implies, which `plan:scaffold` writes with the policy. `plan:status` calls an entry `wired` once the entry's `createApp()` lists its file's default export, and `plan:approve` accepts an added entry on its step's verified run, as it does a command. The rendered plan shows both sections, and the producer prompt describes them.

`guren change:lane` lowers a `provider-added` or `config-added` fact to `low` when one open plan adds an element of that name and the entry is a default import of the element's file, with no file of another extension beside it. A `config-added` fact was `medium` whatever the plan said.
