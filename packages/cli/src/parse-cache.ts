import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parse, type ParserPlugin } from '@babel/parser'
import type { File } from '@babel/types'

export interface ParsedFile {
  ast: File
  source: string
}

/**
 * The two states are not interchangeable: an unreadable file has no source to
 * fall back on, while an unparseable one still serves the regex-only scans.
 */
export type ParseOutcome =
  | { status: 'parsed'; ast: File; source: string }
  /** Read succeeded, Babel rejected the source under every dialect tried. */
  | { status: 'unparsed'; source: string }
  /** The file could not be read at all (missing, permissions, a directory). */
  | { status: 'unreadable' }

/**
 * Decorator dialects, in the order attempted. Measured against this repo's
 * `@babel/parser`: only `decorators` parses `export @Dec class X {}`, only
 * `decorators-legacy` parses `constructor(@inject() private x)`, and enabling
 * both at once is a config error. Legacy first, the commoner shape; a file
 * mixing both forms parses under neither order (see parse-cache.test.ts).
 */
const DECORATOR_PLUGINS: readonly ParserPlugin[] = ['decorators-legacy', 'decorators']

/** Whether the JSX variant should be attempted before the non-JSX one. */
function prefersJsx(filePath?: string): boolean {
  if (filePath === undefined) return false
  const ext = extname(filePath)
  return ext !== '.ts' && ext !== '.mts'
}

/**
 * Plugin sets to try, best guess first. JSX is not decidable from the
 * extension: `<Type>value` casts parse only *without* the `jsx` plugin and JSX
 * elements only *with* it, so the extension orders the attempts rather than
 * deciding them. Exported for tests only — production goes through
 * `parseSourceFile`, which is what applies the retry.
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
   * Return a partial AST for source Babel rejects, instead of null. Never used
   * by `ParseCache`, which is keyed by path alone and treats "did not parse"
   * as the signal to skip. It also makes the retry ladder moot — the first
   * candidate returns a partial AST rather than throwing — which is harmless
   * only because the one caller reads static property literals alone.
   */
  errorRecovery?: boolean
}

/**
 * Tries each candidate plugin set until one succeeds. `filePath` only orders
 * the attempts, so omitting it costs an extra parse rather than correctness.
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
      // Unparseable only once every dialect has failed.
    }
  }
  return null
}

/**
 * Per-invocation Babel parse cache, keyed by absolute file path, so the
 * `guren check` checkers that want the same controllers read and parse each
 * file once. Plugin selection is derived from the path rather than supplied,
 * so the cache stays correct whichever checker asks first. `skippedFiles()` is
 * scoped to one instance — hoisting a cache across calls would mix them.
 */
export class ParseCache {
  private readonly cache = new Map<string, Promise<ParseOutcome>>()
  private readonly skipped = new Map<string, 'unparsed' | 'unreadable'>()

  /**
   * The full outcome, for callers whose AST is *optional*. Records no skip:
   * `get()` and `source()` record against the contract they actually needed,
   * and a skip here would report a file as unchecked that was checked.
   */
  read(filePath: string): Promise<ParseOutcome> {
    let pending = this.cache.get(filePath)
    if (!pending) {
      pending = this.readAndParse(filePath)
      this.cache.set(filePath, pending)
    }
    return pending
  }

  /** Null either way counts as skipped: this caller needed an AST. */
  async get(filePath: string): Promise<ParsedFile | null> {
    const outcome = await this.read(filePath)
    if (outcome.status === 'parsed') return { ast: outcome.ast, source: outcome.source }
    this.skipped.set(filePath, outcome.status)
    return null
  }

  /**
   * For the regex-only scans, which a syntax error elsewhere should not
   * disable: `unparsed` satisfies this caller, so only unreadable is a skip.
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
   * Files a caller needed and did not get. A file that failed to parse but was
   * served to `source()` is absent: nothing that asked for it went unserved.
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
