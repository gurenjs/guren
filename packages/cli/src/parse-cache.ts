import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parse, type ParserPlugin } from '@babel/parser'
import type { File } from '@babel/types'

export interface ParsedFile {
  ast: File
  source: string
}

/**
 * Why a file produced no AST, kept distinct because the two states are not
 * interchangeable to a caller: an unreadable file has no source to fall back
 * on, while an unparseable one does — several checks are regex-only scans that
 * work fine on source a parser rejected.
 */
export type ParseOutcome =
  | { status: 'parsed'; ast: File; source: string }
  /** Read succeeded, Babel rejected the source under every dialect tried. */
  | { status: 'unparsed'; source: string }
  /** The file could not be read at all (missing, permissions, a directory). */
  | { status: 'unreadable' }

/**
 * Decorator dialects, in the order they are attempted.
 *
 * No single Babel plugin set parses every decorator TypeScript accepts, so the
 * choice cannot be made once and baked in — which is what made this class of
 * bug possible. Measured against this repo's `@babel/parser`:
 *
 * | source                             | `decorators` | `decorators-legacy` |
 * | ---------------------------------- | ------------ | ------------------- |
 * | `@Dec export class X {}`           | yes          | yes                 |
 * | `export @Dec class X {}`           | yes          | no                  |
 * | `constructor(@inject() private x)` | no           | yes                 |
 *
 * Legacy goes first: parameter decorators are the norm in DI-flavoured apps
 * (tsyringe, InversifyJS, `experimentalDecorators: true`) — exactly the code
 * this fix exists to make visible, and the shape this repo's own fixtures use
 * — while `export @Dec class X` (the one form legacy alone can't parse) is a
 * rarer style. This ordering makes the common case cost one parse attempt
 * instead of two; the two Babel plugins cannot both be enabled at once
 * (`@babel/parser` throws a config error), so there is no way to try them
 * together and no way to avoid a second attempt for whichever form the first
 * guess didn't cover.
 *
 * One combination is unparseable under either order: a single file mixing
 * `export @Dec class X` with a legacy parameter decorator has no plugin set
 * that accepts both halves at once. Verified as a genuine `@babel/parser`
 * limitation, not a gap in this list — see the "unparseable under any
 * dialect" test in parse-cache.test.ts.
 */
const DECORATOR_PLUGINS: readonly ParserPlugin[] = ['decorators-legacy', 'decorators']

/** Whether the JSX variant should be attempted before the non-JSX one. */
function prefersJsx(filePath?: string): boolean {
  if (filePath === undefined) return false
  const ext = extname(filePath)
  return ext !== '.ts' && ext !== '.mts'
}

/**
 * Plugin sets to try, best guess first.
 *
 * JSX is not decidable from the extension either: `<Type>value` cast syntax
 * parses only *without* the `jsx` plugin, and a JSX element only *with* it. The
 * extension is a strong hint — TypeScript admits JSX only in `.tsx`/`.jsx`, and
 * `<Type>value` is legal in `.ts` — so it orders the attempts rather than
 * deciding them. A `.js` React component and a `.ts` file full of angle-bracket
 * casts now both parse; before, whichever way the rule guessed wrong was
 * silently dropped.
 *
 * Exported for tests only. Production code goes through `parseSourceFile`,
 * which is what applies the retry — hand-rolling a `parse()` around this list
 * would reintroduce the single-guess bug it exists to prevent.
 */
export function parserPluginCandidates(filePath?: string): ParserPlugin[][] {
  const jsxOrder = prefersJsx(filePath) ? [true, false] : [false, true]
  return jsxOrder.flatMap((jsx) =>
    DECORATOR_PLUGINS.map((dialect) => {
      const plugins: ParserPlugin[] = ['typescript', dialect, 'decoratorAutoAccessors']
      if (jsx) plugins.push('jsx')
      return plugins
    }),
  )
}

export interface ParseSourceOptions {
  /**
   * Return a partial AST for source Babel rejects, instead of null. Opt-in per
   * call and deliberately never used by `ParseCache`: for its callers "did not
   * parse" is the signal to skip a file rather than draw conclusions from a
   * fragment, and the cache is keyed by path alone so it could hold only one
   * option set anyway.
   *
   * Note this makes the retry ladder moot for its one caller
   * (`parseModelSerializationInfo`): with recovery on, the first candidate
   * returns a (partial, error-bearing) AST instead of throwing, so later
   * candidates are never tried. That caller only reads static property
   * literals, never constructor parameters or decorator arguments, so which
   * dialect's partial AST it gets does not change the result — confirmed by
   * the "keeps static members readable" test in parse-cache.test.ts.
   */
  errorRecovery?: boolean
}

/**
 * Parse one already-read source string, trying each candidate plugin set until
 * one succeeds. Returns null when every dialect rejects it.
 *
 * Pass `filePath` whenever the caller has one: it only orders the attempts, so
 * omitting it costs an extra parse rather than correctness.
 */
export function parseSourceFile(
  source: string,
  filePath?: string,
  options: ParseSourceOptions = {},
): File | null {
  for (const plugins of parserPluginCandidates(filePath)) {
    try {
      return parse(source, {
        sourceType: 'module',
        plugins,
        allowAwaitOutsideFunction: true,
        errorRecovery: options.errorRecovery,
      })
    } catch {
      // Try the next dialect — a file is unparseable only once all of them fail.
    }
  }
  return null
}

/**
 * Per-invocation Babel parse cache, keyed by absolute file path. Several
 * `guren check` checkers (empty-method scan, arch boundary checks) need an
 * AST for the same controller/model files; sharing one cache per `runCheck()`
 * call keeps each file read and parsed at most once instead of once per checker.
 *
 * Plugin selection is derived from the path, not caller-supplied, so the cache
 * stays correct regardless of which checker asks first.
 *
 * The cache also remembers which requested files it could not fully serve —
 * see `skippedFiles()`. That list is scoped to one cache instance for the
 * lifetime of one `runCheck()` call; it would silently mix results from
 * unrelated calls if a cache were ever hoisted and reused across them; nothing
 * in this codebase does that today.
 */
export class ParseCache {
  private readonly cache = new Map<string, Promise<ParseOutcome>>()
  private readonly skipped = new Map<string, 'unparsed' | 'unreadable'>()

  /**
   * Full outcome, distinguishing an unreadable file from an unparseable one.
   * Exposed for tests only (promise-identity is how the read-once guarantee is
   * verified) — production callers want `get()` or `source()`, which record
   * `skippedFiles()` against the contract they actually needed.
   */
  read(filePath: string): Promise<ParseOutcome> {
    let pending = this.cache.get(filePath)
    if (!pending) {
      pending = this.readAndParse(filePath)
      this.cache.set(filePath, pending)
    }
    return pending
  }

  /**
   * AST plus source, or null when the file could not be read or parsed. Either
   * way this caller needed an AST and didn't get one, so it counts as skipped.
   */
  async get(filePath: string): Promise<ParsedFile | null> {
    const outcome = await this.read(filePath)
    if (outcome.status === 'parsed') return { ast: outcome.ast, source: outcome.source }
    this.skipped.set(filePath, outcome.status)
    return null
  }

  /**
   * File contents regardless of whether they parsed, or null when unreadable.
   * For the regex-only scans, which a syntax error elsewhere in the file
   * shouldn't disable — an `unparsed` outcome still satisfies this caller, so
   * it is not recorded as skipped; only a genuinely unreadable file is.
   */
  async source(filePath: string): Promise<string | null> {
    const outcome = await this.read(filePath)
    if (outcome.status === 'unreadable') {
      this.skipped.set(filePath, 'unreadable')
      return null
    }
    return outcome.source
  }

  /**
   * Requested files that some caller needed but could not get — an AST from
   * `get()`, or any content at all from `source()`. A file that only ever
   * failed to parse but was successfully read via `source()` is not here,
   * because nothing that asked for it went unserved.
   */
  skippedFiles(): { filePath: string; reason: 'unparsed' | 'unreadable' }[] {
    return [...this.skipped].map(([filePath, reason]) => ({ filePath, reason }))
  }

  private async readAndParse(filePath: string): Promise<ParseOutcome> {
    let source: string
    try {
      source = await readFile(filePath, 'utf-8')
    } catch {
      return { status: 'unreadable' }
    }

    const ast = parseSourceFile(source, filePath)
    return ast ? { status: 'parsed', ast, source } : { status: 'unparsed', source }
  }
}
