---
"@guren/orm": major
"@guren/server": major
"@guren/cli": major
---

Structural mass-assignment protection (RFC 0006).

BREAKING CHANGE: `Model.guarded` and `Model.strictFillable` are removed.
`fillable` is the single allowlist and is always strict; the primary key
(`id`) is always silently stripped from mass-assignment input. Models can
contribute always-denied fields via the new `deniedFields()` hook —
`AuthenticatableModel` denies its resolved password-hash and remember-token
columns (new `rememberTokenField` static), so a request body carrying them
throws a `MassAssignmentException` (new `reason: 'denied' | 'not-fillable'`
property) regardless of `fillable`. Use `forceCreate()`/`forceUpdate()` for
trusted server-side values such as `passwordHash: 'oauth:...'`.

`ModelUserProvider` now reads credential column names from the model contract
(`resolvePasswordHashField()`/`resolveRememberTokenField()`, now public) when
the target extends `AuthenticatableModel`; explicit options remain as
overrides. `AuthManager.useModel()` no longer hardcodes them.

`defineModel()` drops the deprecated `createType` option (use
`optionalOnCreate`/`requireOnCreate`), and `AuthenticatableModel.createType`
no longer widens to `PlainObject` — models extending it directly should
declare their own `createType`; `defineModel()`-based models are unaffected.

CLI: `make:auth` stops emitting the now-redundant `guarded` line;
`guren check` fails on models declaring `guarded`/`strictFillable` and on
`fillable` listing a denied credential column; `guren audit` recognizes
structurally protected auth models and warns when a controller method mixes
`validateBody` with `forceCreate`/`forceUpdate`; `guren upgrade --check-only`
detects the removed statics.
