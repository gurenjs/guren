---
"@guren/cli": patch
---

fix: a decorated class no longer makes a file invisible to `guren check`, `audit`, and codegen

The CLI's Babel parsers did not enable the `decorators` /
`decoratorAutoAccessors` plugins. A single `@Injectable`-style class therefore
made the *whole file* unparseable — and every caller treats an unparseable file
as contributing nothing, silently. Concretely, in an app that uses decorators:

- `check --arch` skipped the file, so a real module- or layer-boundary violation
  in it was never reported. The summary still said `no violations`.
- `check --docs` fell back to the filename for the model's identity, so a doc
  whose `entities:` names the actual class was reported as pointing at a model
  that does not exist — a failure on a correct doc. (Its `@docs`-tag scan was
  never affected: that path already fell back to reading the file directly, so
  tags in a decorated file were still validated. Model identity, resolved
  through `model-parser`, was the real exposure.)
- `audit`, `context <Entity>`, `model:list`, `spec:generate`, and the `data`,
  `channels`, and page-props codegen all dropped the file the same way.

Plugin selection now lives in one place, `parserPluginsFor`, and every call site
that parses app-authored source shares it. Both orderings parse
(`@Dec export class X` and `export @Dec class X`), as do decorated methods,
decorated properties, and `accessor` fields.

Two related fixes fell out of centralizing it:

- `channels` codegen parsed **every** extension with the `jsx` plugin, including
  `.ts`. In a `.ts` file that makes `<Type>value` cast syntax parse as an
  unterminated JSX element, so a channel provider using one contributed no
  channels at all. JSX is now off for `.ts`/`.mts` only, matching what
  `ParseCache` already documented for itself.
- `ParseCache` could not tell callers *why* a file produced no AST. It now
  returns `parsed` / `unparsed` / `unreadable`, and keeps the source of a file
  the parser rejected — the regex-only scans in `check` and `docs-check` use it
  instead of re-reading the file behind the cache's back. `guren doctor`'s deploy
  checks report the two states together in their "could not be read or parsed"
  caveat, which is why the distinction is needed rather than merely tidy.

`errorRecovery` is deliberately *not* shared: audit's model-serialization scan
opts into a partial AST, while every other caller uses "did not parse" as the
signal to skip the file rather than draw conclusions from a fragment.
