# RFC: Structural mass-assignment protection

**Author:** Urata Daiki
**Date:** 2026-07-31
**Status:** Accepted (2026-07-31 — maintainer decision; the standard two-week discussion
window was waived by the project maintainer)

> Scope note: this RFC started as a narrow fix — "make `AuthenticatableModel` strip its
> own hash column" — and was deliberately widened after concluding that the narrow fix
> treats a symptom. The symptom is a writable `passwordHash`; the disease is that input
> protection is spread across three interacting settings (`fillable`, `guarded`,
> `strictFillable`) whose composition decides, per app, whether a credential column is
> protected at all and whether failure is loud or silent. Backward compatibility is
> **not** a design constraint here; this targets the next major. The minimal
> compat-shaped fix survives as an alternative at the end.

## Problem

### The mechanism: three settings, two disjoint paths

`Model.filterFillable()` (`packages/orm/src/Model.ts:671`) implements two mutually
exclusive regimes:

```typescript
static filterFillable(data: PlainObject): PlainObject {
  const fillableFields = this.fillable
  if (fillableFields) {
    // strict (default): any key outside the allowlist throws MassAssignmentException
    // strictFillable === false: keys outside the allowlist are silently dropped
    ...
  }
  const guardedFields = this.guarded ?? ['id']   // reached only when fillable is unset
  ...
}
```

`guarded` is consulted **only when `fillable` is unset** — a fact that is documented, but
that every model in this repo gets wrong in the same direction (below). `strictFillable`
then decides whether the `fillable` path fails loudly or silently. Which cell of this
matrix an app lands in is decided by settings that have nothing to do with what they end
up protecting or exposing.

### The consequence: credential columns are protected by convention

A model extending `AuthenticatableModel` stores its password hash in a column
(`passwordHash` by default, renameable via `protected static passwordHashField`). Nothing
in the framework stops a request body from writing that column; protection depends
entirely on the app's `fillable`/`guarded` composition. Measured on `main` (`63fd323`)
with a capturing adapter:

| Model shape | Body contains | Result on `main` |
|---|---|---|
| default `guarded` (`['id']`) | `passwordHash` | **persisted verbatim** |
| `guarded = ['id', 'passwordHash']` | `passwordHash` | silently dropped |
| `fillable`, `strictFillable = false` | `passwordHash` | silently dropped |
| `fillable = ['email', 'passwordHash']` | `passwordHash` | **persisted verbatim** |
| `fillable` without hash field, strict (all three real apps) | `passwordHash` | throws `MassAssignmentException` |
| `passwordHashField = 'passwordDigest'`, `guarded` copied from the scaffold | `passwordDigest` | **persisted verbatim** |

The scaffold's history compounds this. Until #232, `make:auth` emitted only
`static hidden = ['passwordHash', 'rememberToken']` — **output** filtering, inert on the
input side — so pre-#232 apps sit on the default `guarded = ['id']` while carrying a line
that names `passwordHash` prominently. They look protected and are not. #232 added a
`guarded` line, but the three real apps in this repo also set `fillable`, which makes
that line inert anyway (they are safe only because strict-`fillable` throws first).

The last table row is the structural one: `guarded` is a static string list and cannot
follow `this.passwordHashField`. A model that renames its hash column and keeps the
scaffolded `guarded` line is unprotected while looking protected.

### Adjacent divergences, found while measuring

These are part of the same disease — credential-column knowledge duplicated instead of
owned — and are in scope:

1. **The bulk-update path never hashed** — found while measuring for this RFC, and
   **fixed ahead of it in #234** since it needed no breaking change.
   `QueryBuilder.update()` → `runBulkUpdate` called `filterFillable` then went straight
   to the adapter, skipping `preparePersistencePayload` — the hook where
   `AuthenticatableModel` hashes. Measured on `63fd323`:
   `User.where('id', 1).update({ password: 'secret' })` **persisted a literal plaintext
   `password` column**, no error. Bulk updates now run the same payload preparation as
   `Model.update()` (via `prepareBulkPersistencePayload`); per-record hooks and observers
   stay skipped as documented. The redesign below builds on that unified pipeline rather
   than proposing it.

2. **The credential column is configured in three places with three defaults.** The model
   says `passwordHashField = 'passwordHash'`. `AuthManager.useModel()` hardcodes
   `passwordColumn: 'passwordHash'`, `rememberTokenColumn: 'rememberToken'`
   (`AuthManager.ts:134-135`). A directly constructed `ModelUserProvider` defaults to
   `passwordColumn: 'password'`, `rememberTokenColumn: 'remember_token'`
   (`ModelUserProvider.ts:32-33`) — note the snake_case, matching neither of the others.
   A renamed `passwordHashField` is silently ignored by both provider entry points.

3. **`rememberToken` has the same exposure and no indirection.** It is
   credential-equivalent (possession = a session), sits in the same scaffolded `guarded`
   array with the same inertness, and has no `rememberTokenField` static to follow a
   rename. Its rotation already writes through `forceUpdate`
   (`ModelUserProvider.ts:116`), so it needs no mass-assignment path.

## Proposed Solution

One input mechanism, one deny hook that credential owners contribute to, one persistence
pipeline that every write path shares, one source of truth for column names. Four parts,
each independently measured where a prototype was feasible.

### 1. Collapse the input rules: `fillable` stays, `guarded` and `strictFillable` go

- **`fillable?: string[]`** remains the single app-facing setting: an allowlist, always
  strict. Keys outside it throw `MassAssignmentException`. No flag restores silent
  dropping — silent dropping is the failure mode this redesign exists to remove, and
  `strictFillable = false` has **zero** non-test usage in this repo.
- **`guarded` is deleted.** Its blacklist model is unsound (every newly added column is
  writable by default), its interplay with `fillable` is the confusion documented above,
  and its two remaining legitimate jobs are taken over: `id` by the primary-key rule
  below, credential columns by the deny hook.
- **The primary key is always silently stripped** from mass-assignment input (today's
  `guarded` default, kept as behavior but no longer configurable). Stripping rather than
  throwing is deliberate: an `id` round-tripped from a form is benign — it cannot
  retarget the write, the `where` clause governs that — whereas a credential column in
  the body is a bug or an attack. Benign input is tolerated, dangerous input throws.

Without `fillable`, the default is what it is today: every column except the primary key
and the denied set. `fillable` narrows from there.

### 2. A dynamic deny hook: `protected static deniedFields(): string[]`

```typescript
// Model — the default
protected static deniedFields(): string[] {
  return []
}

// AuthenticatableModel
protected static rememberTokenField = 'rememberToken'   // NEW indirection, mirrors passwordHashField

protected static resolveRememberTokenField(): string {
  return (this.rememberTokenField ?? 'rememberToken') as string
}

protected static override deniedFields(): string[] {
  const denied = [...super.deniedFields()]
  const hashField = this.resolvePasswordHashField()
  if (hashField !== this.resolvePasswordField()) denied.push(hashField)
  denied.push(this.resolveRememberTokenField())
  return denied
}
```

`filterFillable` checks the deny list **on the raw input, before any other rule**:

```typescript
static filterFillable(data: PlainObject): PlainObject {
  const denied = this.deniedFields().filter((field) => field in data)
  if (denied.length > 0) {
    throw new MassAssignmentException(this.name, denied, { reason: 'denied' })
  }
  // ... fillable allowlist check, primary-key strip ...
}
```

Why these specifics are load-bearing:

- **Raw input, not the filtered result.** Checking after filtering is not unconditional:
  a rule that removed the key first would hide it from the check, resurrecting the silent
  strips. Checking first also guarantees the credential-specific error is the one the
  caller reads.
- **A method, not a static array.** The whole reason `guarded` failed here is that a
  static list cannot read `this.passwordHashField`. The hook resolves at call time, so a
  renamed column — hash or remember-token — stays covered. This also answers why the
  hook, rejected in the narrow version of this RFC as "`guarded` with extra steps", is
  now right: with `rememberTokenField` introduced, there are two dynamically-resolved
  credential columns to feed it, which is exactly the threshold where the general
  mechanism starts paying for itself.
- **The `hashField !== passwordField` guard** preserves the supported same-column
  configuration (plaintext `password` hashed in place into the same column —
  `preparePersistencePayload` handles it explicitly at `AuthenticatableModel.ts:52`).
  Measured: with the guard, such a model still hashes plaintext correctly.
- **Denied always throws, `fillable` content notwithstanding.** Listing a denied field in
  `fillable` does not open it; it throws at write time. (A definition-time assertion is
  Open Question 3.)
- **`force*` writes remain the sanctioned hatch** and skip `filterFillable` entirely, as
  today: `forceCreate({ passwordHash: 'oauth:github' })` for OAuth-only accounts (already
  the documented pattern in `Model`'s JSDoc), `forceUpdate` for remember-token rotation
  (already what `ModelUserProvider` does), `db.insert()` for seeders.

The guarantee, stated precisely: **no raw key named by `deniedFields()` reaches
persistence through a non-`force` write API.** Values introduced downstream by hooks,
observers, or mutators are not covered (they run after filtering), nor is a subclass that
overrides `filterFillable` without delegating — the claim is that the safe path is the
default, not that the unsafe one is unreachable.

### 3. One persistence pipeline: bulk updates go through `preparePersistencePayload`

**Shipped ahead of this RFC as #234** (non-breaking, so it did not need to wait for the
major): `runBulkUpdate` now routes both `update()` and `forceUpdate()` payloads through
`prepareBulkPersistencePayload`, giving the bulk path the same mutators → casts →
hashing sequence as `Model.update()`, with per-record hooks and observers still skipped.
This RFC's prototype of the same change measured the fix before it landed:
`User.where('id', 1).update({ password: 'secret' })` persists
`passwordHash: '$argon2id$…'` with no `password` key, orm + server suites 2054 pass /
0 fail. What remains for this RFC is only the interaction guarantee: the deny hook (part
2) fires on the bulk path too, because `runBulkUpdate` calls `filterFillable` before
preparation.

### 4. One source of truth for credential columns: the provider asks the model

`ModelUserProvider` currently receives `passwordColumn` / `rememberTokenColumn` as
constructor options with defaults that contradict both the model and `AuthManager`. In
the redesign, when the target model extends `AuthenticatableModel`, the provider reads
the columns off the model contract:

```typescript
const passwordColumn = options.passwordColumn
  ?? (isAuthenticatable(model) ? model.resolvePasswordHashField() : 'passwordHash')
const rememberTokenColumn = options.rememberTokenColumn
  ?? (isAuthenticatable(model) ? model.resolveRememberTokenField() : 'rememberToken')
```

`AuthManager.useModel()` drops its hardcoded pair and passes nothing. A model that
renames its hash column now gets correct verification, correct remember-token lookup,
and correct mass-assignment denial from the single rename — the three-defaults
divergence (`'passwordHash'` / `'password'` / `'remember_token'`) disappears. The
explicit options remain as overrides for non-`AuthenticatableModel` targets.

### 5. Exceptions and types follow the runtime rule

- **`MassAssignmentException` gains `reason: 'denied' | 'not-fillable'`** (constructor
  option; additive). The current message's remediation — "add to fillable / set
  `strictFillable = false`" — is wrong for denied fields and refers to a setting this
  RFC deletes. `reason: 'denied'` renders: *"`passwordHash` is a credential column and
  can never be mass-assigned. Pass a plain `password` and let the model hash it, or use
  `forceCreate()`/`forceUpdate()` for trusted server-side values such as
  `passwordHash: 'oauth:github'`."* No `statusCode`, so it stays a 500 — programming
  error or injection attempt, not a 422.
- **`createType` omits denied columns.** `defineModel(users, { base: AuthenticatableModel })`
  already lets apps shape the create payload with `optionalOnCreate`/`requireOnCreate`
  (#232); the scaffold currently writes `optionalOnCreate: ['passwordHash']`. With the
  runtime rule in place, the scaffold and docs ~~move to omitting the hash from `createType`
  entirely (`forceCreate` accepts the full insert type), so the compiler and the runtime
  tell the same story~~ **Amended in implementation:** keep `optionalOnCreate` —
  `forceCreate()` is typed by the same `createType` marker, so omitting the hash there
  would also remove it from the sanctioned `forceCreate({ passwordHash: 'oauth:...' })`
  path, and a separate force-payload type marker is more machinery than the type/runtime
  mismatch justifies. The runtime deny is authoritative; the type fixture and docs note
  the mismatch explicitly.
- **Bundled type cleanups, same major:** remove the deprecated `createType` option from
  `defineModel()` (`Model.ts:2604`); drop the `PlainObject &` widening from
  `AuthenticatableModel.createType`, letting the `NamedKeys<T>` helper (`Model.ts:2540`)
  — which exists only to strip that index signature back out — delete itself.

### The resulting model, in one table

| Input key | Result |
|---|---|
| in `deniedFields()` (hash, remember token) | throw, always |
| primary key | silently stripped |
| outside `fillable` (when set) | throw |
| everything else | passes to `preparePersistencePayload` (mutators → casts → hashing) on **every** non-`force` path, including bulk |
| any key via `forceCreate`/`forceUpdate`/`db.insert()` | passes untouched — the trusted hatch |

## Agent-first rationale and harness surface

Guren's development model assumes AI coding agents generate most application code, with
the CLI (`guren check` / `guren audit`) and the installed harness (rules, skills) keeping
them honest. That assumption is not neutral in this design — it is an argument for it,
and it defines a concrete surface the implementation must update.

### Why convention-based protection fails specifically under agents

The strongest evidence in this RFC is how the inert `guarded` lines got everywhere: the
scaffold emitted them, the harness skills documented them
(`.claude/skills/feature/SKILL.md`, `.claude/skills/guren-api/SKILL.md`, and their
`packages/cli/templates/agent/` twins), and agents copied them into all three real apps.
That is the normal agent workflow operating correctly — **agents propagate the patterns
the harness shows them**, protective-looking or not. A convention that must be composed
correctly per model (`guarded` that only works without `fillable`) decays precisely in
that copy loop, while looking like security in every diff. Structural enforcement is the
version of this rule that survives being copied: whatever an agent emits or omits, the
credential columns are closed.

In RFC 0004 terms: today the protection is *declared* (per-app, per-model, twice); this
design makes it *derived* (from the model contract) and *checked* (below). The rule
surface agents must learn shrinks accordingly — the harness's `orm-models.md` currently
spends a paragraph on the three-setting matrix, including the `strictFillable = false`
escape it should never recommend; the replacement is three lines (allowlist throws,
credentials always throw, `force*` is the trusted hatch).

### Harness and CLI surface to update (verified against current source)

| Surface | Today | Under this RFC |
|---|---|---|
| `guren audit` (`audit.ts:637-651`) | one regex: passes if `static fillable\|guarded` present, else warns | two-tier: `AuthenticatableModel` subclasses pass structurally (note, not warn — the warn would be a false positive); plain models keep the `fillable` hygiene warn, with `guarded` dropped from regex and remediation text |
| `guren check` | no mass-assignment rules | new static rule: `fillable` ∩ denied fields is a definition error (Open Question 3's home — ~~plus a runtime twin in `bootModels()`~~ **Amended in implementation:** no boot twin; the write-time denied throw already covers runtime with a clearer message, so a boot assertion adds a failure mode without adding protection); statically feasible because the denied set's *inputs* are parseable statics (`passwordHashField`, `rememberTokenField`, base-class identity) |
| `guren upgrade --check-only` (`deprecations.ts`) | — | `detect()` entries for `static guarded` / `static strictFillable` / hash-field writes: a mechanical, agent-consumable migration worklist |
| harness rules (`templates/agent/.claude/rules/orm-models.md`) | documents the six-cell matrix incl. `strictFillable = false` | rewritten to the three-line model above |
| skills (`feature`, `guren-api`, root and template copies) | show `static guarded = ['id', 'passwordHash', 'rememberToken']` | drop the line; show `fillable` only |
| `guren guidelines` (`guidelines.ts:108`) | "Declare `static fillable` …" | unchanged — still correct |
| `model-parser.ts` / `model:list` / `context` | do not parse `fillable`/`guarded` | no change needed (verified: zero references) |

Two implementation disciplines carry over from this repo's history with static checks:
new and changed `audit`/`check` rules must be validated **in both directions** (fires on
a seeded violation, silent on `examples/blog` and `web/` as they exist after migration),
and scaffold changes must be verified through the full loop — generate, `codegen`, `tsc`,
`audit` — not by asserting file contents.

### What an agent can still get wrong — residual risks and their mitigations

"Agent-generated code is secure by default" is the claim; it is worth being precise about
what it does *not* mean. The honest framing is defense in depth: the Zod schema in
`validateBody` is the first net (Zod objects strip unknown keys, so only schema-declared
fields reach the model at all), `filterFillable` is the second, and the `force*` boundary
is the third. The residual risks are the ways an agent can cut through all three, in
descending order of likelihood:

1. **Escalating to `force*` to silence the exception.** This is the predictable agent
   failure mode under the new design: hit `MassAssignmentException`, "fix" it by
   switching the call to `forceCreate()` with the same request-derived payload — the
   exception message itself names `forceCreate` as the remedy for trusted values, and an
   agent is exactly the reader that may skip the *trusted* qualifier. Mitigations, all in
   scope for the implementation: (a) the `reason: 'denied'` message must carry an
   explicit negative — *"never call `force*` with request input"* — not just a positive
   recommendation; (b) the harness `orm-models.md` states the same rule as a hard
   prohibition rather than today's one-line aside; (c) `guren audit` gains a heuristic
   finding for `force*` whose argument derives from `validateBody`/request data in the
   same controller method (verified: audit has **zero** `force*` checks today). Static
   detection cannot be complete here; the audit finding is a review prompt, not a gate.
2. **App-specific privilege columns are outside the structural net.** `deniedFields()`
   protects what the framework can identify — credentials. A model with `role`,
   `isAdmin`, or `balance` and **no `fillable`** exposes those columns exactly as today
   (the no-`fillable` default admits every non-denied column). The existing audit warn
   on missing `fillable` is the current mitigation, but it is a hygiene nudge, not a
   gate. Two strengthenings in scope: ~~extend the audit to cross-reference schema columns
   against a privilege-column pattern (a sibling of `SENSITIVE_COLUMN_PATTERN`,
   `audit.ts:581`, for `role|admin|balance|verified`-class columns)~~
   **Amended in implementation:** deferred — validated against the real apps, the obvious
   pattern false-positives immediately (`examples/blog` legitimately lists
   `emailVerifiedAt` in `fillable`; a `verified` match would flag it), and a pattern
   narrow enough to avoid that catches little. Needs a design that distinguishes
   privilege flags from verification timestamps before it ships. And resolve Open
   Question 4 toward exposing `deniedFields()` so apps — and the agents writing them —
   have a blessed place to register such columns.
3. **Legacy patterns from training data compile silently.** After `guarded` and
   `strictFillable` are deleted, a freshly generated `static guarded = [...]` is not an
   error — it is an inert property TypeScript happily accepts (no `override` involved).
   An agent reproducing pre-2.0 patterns from its training data would ship dead-looking
   protection with no signal, which is precisely the pathology this RFC removes.
   Mitigation: the `guren check` rule from the table above also flags any model declaring
   `guarded`/`strictFillable` as a definition error — cheap, static, and it converts
   "silently inert" into "loudly wrong" for exactly the population most likely to write
   it. (`guren upgrade` covers existing code; this check covers newly generated code.)
4. **Writes outside the Model API.** `db.insert()`/raw Drizzle with request-derived data
   bypasses every net. This is inherent — the seeder pattern depends on it — and the
   mitigation is unchanged from today: harness rules direct agents to Model APIs for
   request-handling code, and `audit`'s raw-SQL findings cover part of the surface.

None of these weaken the core claim — each is strictly no worse than today, and 1 and 3
have new mitigations this RFC adds. The claim, restated with the residuals priced in:
**an agent following the harness produces secure writes by default, an agent deviating
from it trips a static finding on the two most likely deviations, and the remaining
exposures require the same deliberate steps they require today.**

## Measured verification

All prototypes were exercised on `63fd323` and reverted; nothing is committed.

- Deny-on-raw-input override (narrow form): all six problem-table shapes converge on
  throw; `QueryBuilder.update()` dispatches the static override correctly (resolved off
  `this.modelClass`, `QueryBuilder.ts:443`); `forceCreate` hatch and plain-password happy
  path unaffected; same-column configuration still hashes. `test:bun` 3096 pass / 0 fail,
  `test:examples` all 59 files pass, `typecheck` clean.
- Bulk-pipeline routing: plaintext bulk update hashes correctly; orm + server suites
  2054 pass / 0 fail. (Independently implemented and merged as #234 with its own tests;
  the prototype predates that landing.)
- Write-site census across `examples/`, `web/`, `packages/` (tests included, shorthand
  syntax matched): the only hash-field writes are two seeders using `db.insert()`
  (unaffected) and two non-`AuthenticatableModel` ORM test fixtures. **No call site
  passes a hash field to a non-`force` Model write API.** `strictFillable` has no
  non-test usage; every `guarded` in a real app is inert (all also set `fillable`).
- Coverage is closed: `@guren/orm`'s only mass-assignment call sites are
  `Model.create()`, `Model.update()`, and `QueryBuilder.update()` (`Model.ts:1592`,
  `Model.ts:1679`, `QueryBuilder.ts:443`); there is no `createMany`, `upsert`,
  `updateOrCreate`, or `firstOrCreate`. `SoftDeletes` writes one fixed column, never
  caller data.

What was *not* prototyped: `guarded`/`strictFillable` removal (their tests obviously
fail until rewritten), the provider unification, and the type-marker change for
`createType` omission. The mechanics those rely on — static-method dispatch through
`QueryBuilder`, resolve-at-call-time field lookup — are the same ones measured above.

## Alternatives Considered

**The narrow override (this RFC's original form).** Keep `guarded`/`strictFillable`;
`AuthenticatableModel.filterFillable` rejects the raw hash field and delegates to
`super`. Fully measured (see above), minimal blast radius, and the right choice **if**
compat pressure returns. Rejected as the target state because it treats one cell of the
matrix: apps keep landing in silent-drop cells for every column that is not the hash,
and the provider/model column divergence stays.

**Deny at the write-runner level** (`runCreate`/`runUpdate`/`runBulkUpdate`) instead of
in `filterFillable`. Harder for a subclass to bypass, and could inspect hook/mutator
output. Rejected: `filterFillable` is the name the framework already gives to "the input
protection step", and moving auth knowledge into the ORM's runners couples layers that
`deniedFields()` keeps cleanly separated (the ORM defines the hook, `@guren/server`
contributes to it). Revisit if subclass override evasion is observed in practice.

**Keep `guarded` but consult it even when `fillable` is set.** Fixes the inertness
surprise, keeps the blacklist unsoundness and the static-list rename problem, adds a
third interaction to the matrix instead of deleting the matrix.

**Strip credential fields silently instead of throwing.** Produces accounts that cannot
be logged into and a bug report weeks later; converts today's loud failures (the three
real apps) into silent ones. The strip-vs-throw split in this design is principled:
strip what is benign (primary key), throw on what is dangerous (credentials, allowlist
violations).

**Default-deny everything until `fillable` is declared** (require every model to opt
columns in). Maximally safe, hostile to prototyping, and unnecessary: the dangerous
columns are exactly the ones the framework can identify structurally.

## Migration Path

Major-only. In-repo blast radius is the measured zero above plus the mechanical rewrites
this RFC itself carries (scaffold, examples, docs, `guarded`/`strictFillable` tests).

For apps, in likely order of frequency:

1. **`guarded` lines: delete.** In every scaffolded/example shape they are either inert
   (`fillable` also set) or replaced by the structural rules (`id` → primary-key strip,
   credentials → deny hook). A codemod handles this safely — pure deletion.
2. **`strictFillable = false`: delete, then fix what throws.** Each new throw is a key
   the app was silently losing; the fix is adding it to `fillable` or dropping it from
   the payload. Detectable statically; listed by `guren upgrade --check-only`.
3. **Precomputed-hash writes: switch to `forceCreate`/`forceUpdate`.** No codemod — the
   correct replacement depends on whether the value is trusted, and guessing wrong
   silently changes an authentication path. The migration guide carries the pattern.
4. **Bulk updates that relied on skipped mutators/casts:** already shipped in #234 as a
   bug fix, ahead of the major — no additional migration under this RFC. (Apps that
   bulk-updated a plaintext `password` column were writing plaintext passwords; they now
   get hashing.)
5. **Provider options:** apps passing explicit `passwordColumn`/`rememberTokenColumn`
   keep working (options override the contract); apps that renamed the model field and
   *also* passed matching options can drop the options.

Deprecation mechanics per `contributing/deprecation-policy.md` (register in
`packages/cli/src/deprecations.ts`, runtime warnings, ≥2 minors before the major) apply
to `guarded`, `strictFillable`, and the hash-write pattern; the policy interaction is
operational detail, not design, and is left to the release plan.

## Open Questions

1. **Primary-key strip vs throw.** Stripping is proposed (benign round-trip; the `where`
   clause targets the write, so a body `id` cannot retarget it). The counterargument is
   uniformity — "unexpected key → throw" with no exceptions. Stripping matches today's
   default and keeps form round-trips working; flagged for the discussion period.
2. **Unknown-key detection without `fillable`.** With `guarded` gone and no allowlist, a
   typo'd column name passes `filterFillable` and fails later (or worse, is silently
   ignored by the adapter). The Drizzle table knows its columns; `filterFillable` could
   throw on keys that are neither columns nor denied. Attractive — it is the last silent
   cell in the matrix — but requires runtime column introspection on every write;
   measure before adopting.
3. **Definition-time assertion for `fillable` ∩ `deniedFields()`.** Writing
   `fillable = [..., 'passwordHash']` is a contradiction that currently surfaces only at
   the first write. Proposed home (see the harness section): a static rule in
   `guren check` plus a runtime twin in `bootModels()`. Remaining question is only
   whether the runtime twin throws or warns.
4. **Should `deniedFields()` be public API for apps?** The hook is `protected` and
   designed for framework subclasses (`AuthenticatableModel`), but an app with its own
   sensitive column (`isAdmin`, `balance`) may want in. Exposing it is zero extra
   mechanism; the question is whether to document it as the blessed replacement for
   those `guarded` use cases or keep the surface small initially.
5. **Exception granularity.** `reason` field vs a `CredentialAssignmentException`
   subclass. The field is proposed (smaller surface, one `catch` target); a subclass
   remains a compatible follow-up if apps demonstrate a need to handle the two cases
   differently.

### Test coverage the implementation must add

One case per decision point: deny via each path (`create`, `update`, bulk `update`) ×
(default hash field, renamed hash field, renamed remember-token field); same-column
configuration still hashing; primary-key strip; `fillable` violation still throwing;
denied-field-in-`fillable` still throwing; `force*` and `db.insert()` bypassing; bulk
path applying mutators, casts, and hashing; provider column resolution from the model
contract with and without explicit options; and removal tests asserting `guarded` /
`strictFillable` no longer exist as API.
