---
"@guren/cli": minor
"@guren/server": patch
"create-guren-app": patch
---

**New lint rule `guren/no-nullish-env-default`** — `process.env.FOO ?? 'default'` falls back only on `undefined`, so a key that is present but blank (`FOO=` in `.env`, or a hosting dashboard's cleared variable) passes an empty string through and names something that does not exist. That shipped in six generated configs: a session store called `''`, a cache store called `''`, an SMTP port of `0` from `Number('')`. The rule reports a non-empty string or numeric fallback and suggests `||`; `?? ''` is left alone, since both operators behave the same there, and a non-literal fallback cannot be judged from syntax. It is enabled in this repo and in the `.oxlintrc.json` the app templates and `guren add lint` ship, because the defect it was written for lives in scaffold output.

`@guren/server` carries the same fix at its own sites: a blank `AWS_REGION`, `AWS_LAMBDA_FUNCTION_VERSION` or `GUREN_INERTIA_ENTRY` no longer wins over the documented default, and `parseInt(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? '128', 10)` no longer yields `NaN`.

Where an empty value really is a choice — a mail `from` display name — the line carries `oxlint-disable-next-line guren/no-nullish-env-default` with that reason.
