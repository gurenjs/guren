---
"@guren/cli": patch
---

`make:feature --test` writes its test to `tests/controllers/<Name>Controller.test.ts` (in a module, `modules/<name>/tests/controllers/`), the file `make:test --controller` writes and `guren check` / `guren doctor` look for. It used to write `tests/<Name>.test.ts`, so a freshly scaffolded feature was reported as having no controller test.
