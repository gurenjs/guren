---
"@guren/cli": patch
---

fix: a decorated class no longer makes a file invisible to `guren check`, `doctor`, `audit`, and codegen

The CLI's Babel parsers did not enable any decorator plugin. A single
`@Injectable`-style class therefore made the *whole file* unparseable — and
every caller treats an unparseable file as contributing nothing, silently.
Concretely, in an app that uses decorators:

- `check --arch` skipped the file, so a real module- or layer-boundary
  violation in it was never reported. The summary still said `no violations`.
- `check --docs` fell back to the filename for the model's identity, so a doc
  whose `entities:` names the actual class was reported as pointing at a model
  that does not exist — a failure on a correct doc. (Its `@docs`-tag scan was
  never affected: that path already re-read the file directly.)
- `doctor --next` emitted no "Implement `X.y()`" steps for the file.
- `audit`, `context <Entity>`, `model:list`, `spec:generate`, and the `data`,
  `channels`, and page-props codegen all dropped the file the same way.

Plugin selection now lives in one place, `parseSourceFile()`, shared by every
call site that parses app-authored source.

**Plugin choice is a retry, not a guess.** No single Babel plugin set parses
everything TypeScript accepts, so picking one and baking it in is what made
this class of bug possible in the first place:

| source                             | `decorators` | `decorators-legacy` |
| ---------------------------------- | ------------ | ------------------- |
| `@Dec export class X {}`           | yes          | yes                 |
| `export @Dec class X {}`           | yes          | no                  |
| `constructor(@inject() private x)` | no           | yes                 |

The same is true of JSX in the other direction: `<Type>value` cast syntax
parses only *without* the `jsx` plugin, a JSX element only *with* it. So the
file extension now *orders* the attempts instead of deciding them, and a file
counts as unparseable only once every dialect has rejected it. Parameter
decorators (tsyringe, InversifyJS, `experimentalDecorators: true`) and `.js`
React components both parse now; previously each was silently dropped by
whichever rule guessed wrong.

**Skipped files are now reported — for the suites that share the cache.**
Making more files parse does not fix the underlying hazard, which is that a
checker skipping a file it could not read is indistinguishable from one that
found nothing wrong. `guren check` now ends with a `scan-coverage` warning
naming files that some checker needed and couldn't get: the core suite
(empty-method scan, Inertia page refs), `--arch`, and `--docs`' `@docs`-tag
scan. `guren doctor`'s deploy checks already did this; this brings `check` in
line for those suites.

Not yet covered: `--spec`'s controller scan and `--docs`' model-identity
lookup (which falls back to filename, `parseModelFile`) parse independently of
this cache, so a file failing there produces no `scan-coverage` entry — a
known gap, not silently claimed as fixed.

Two related fixes fell out of centralizing it:

- `channels` codegen parsed **every** extension with the `jsx` plugin,
  including `.ts`, so a channel provider using `<Type>value` contributed no
  channels at all.
- `ParseCache` could not tell callers *why* a file produced no AST. It now
  returns `parsed` / `unparsed` / `unreadable` and keeps the source of a file
  the parser rejected, so the regex-only scans in `check` and `docs-check` stop
  re-reading files behind the cache.

`errorRecovery` remains opt-in per call (audit's model-serialization scan wants
a partial AST; every other caller uses "did not parse" as the signal to skip a
file) and is never used by the cache, which is keyed by path alone.

Legacy decorators are tried before standard ones: the two Babel plugins can't
both be enabled at once, and parameter decorators — the DI-flavoured shape this
fix exists to cover — parse only under the legacy dialect, so trying it first
makes that common case cost one parse attempt instead of two. One combination
remains genuinely unparseable under either order — a single file mixing
`export @Dec class X` with a legacy parameter decorator — because no Babel
plugin set accepts both halves at once; that's now a documented, tested
limitation rather than a silent gap.

`scan-coverage` no longer misreports a file as skipped when a caller only
needed its source text and got it (the `@docs`-tag scan, Inertia page refs):
only a caller that genuinely needed an AST and didn't get one — or a file that
couldn't be read at all — counts. Also reused `extractClassDeclaration` in
`check.ts`'s and `doctor.ts`'s empty-method scans (previously duplicated
two-branch inline logic that, unlike the shared helper, didn't match a bare,
non-exported class) and extracted the "first 3, then `and N more`" truncation
`check.ts` and `deploy-runtime.ts` both needed into a shared helper.
