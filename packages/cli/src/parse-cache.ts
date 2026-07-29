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
 * Parameter decorators are the norm in DI-flavoured apps (tsyringe,
 * InversifyJS, `experimentalDecorators: true`) — exactly the code this fix
 * exists to make visible — so covering only the standard dialect would have
 * left the reported bug in place for its most common real-world shape.
 * Standard goes first because it is the spec-track dialect.
 */
const DECORATOR_DIALECTS: readonly ParserPlugin[][] = [
  ['decorators', 'decoratorAutoAccessors'],
  ['decorators-legacy', 'decoratorAutoAccessors'],
]

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
    DECORATOR_DIALECTS.map((dialect) => [
      'typescript' as ParserPlugin,
      ...dialect,
      ...(jsx ? (['jsx'] as ParserPlugin[]) : []),
    ]),
  )
}

export interface ParseSourceOptions {
  /**
   * Return a partial AST for source Babel rejects, instead of null. Opt-in per
   * call and deliberately never used by `ParseCache`: for its callers "did not
   * parse" is the signal to skip a file rather than draw conclusions from a
   * fragment, and the cache is keyed by path alone so it could hold only one
   * option set anyway.
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
 * The cache also remembers which requested files produced no AST. That list is
 * what lets `runCheck` report an incomplete scan rather than quietly returning
 * fewer results — a checker that skipped a file it could not read is otherwise
 * indistinguishable from one that found nothing wrong.
 */
export class ParseCache {
  private readonly cache = new Map<string, Promise<ParseOutcome>>()
  private readonly skipped = new Map<string, 'unparsed' | 'unreadable'>()

  /** Full outcome, distinguishing an unreadable file from an unparseable one. */
  read(filePath: string): Promise<ParseOutcome> {
    let pending = this.cache.get(filePath)
    if (!pending) {
      pending = this.readAndParse(filePath)
      this.cache.set(filePath, pending)
    }
    return pending
  }

  /** AST plus source, or null when the file could not be read or parsed. */
  async get(filePath: string): Promise<ParsedFile | null> {
    const outcome = await this.read(filePath)
    return outcome.status === 'parsed' ? { ast: outcome.ast, source: outcome.source } : null
  }

  /**
   * File contents regardless of whether they parsed, or null when unreadable.
   * For the regex-only scans, which a syntax error elsewhere in the file
   * shouldn't disable.
   */
  async source(filePath: string): Promise<string | null> {
    const outcome = await this.read(filePath)
    return outcome.status === 'unreadable' ? null : outcome.source
  }

  /**
   * Requested files that yielded no AST, for reporting. Only reflects what
   * callers actually asked for, so it never warns about a file no checker
   * looked at.
   */
  skippedFiles(): { filePath: string; reason: 'unparsed' | 'unreadable' }[] {
    return [...this.skipped].map(([filePath, reason]) => ({ filePath, reason }))
  }

  private async readAndParse(filePath: string): Promise<ParseOutcome> {
    let source: string
    try {
      source = await readFile(filePath, 'utf-8')
    } catch {
      this.skipped.set(filePath, 'unreadable')
      return { status: 'unreadable' }
    }

    const ast = parseSourceFile(source, filePath)
    if (!ast) {
      this.skipped.set(filePath, 'unparsed')
      return { status: 'unparsed', source }
    }
    return { status: 'parsed', ast, source }
  }
}
