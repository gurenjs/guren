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
  /** Read succeeded, Babel rejected the source. */
  | { status: 'unparsed'; source: string }
  /** The file could not be read at all (missing, permissions, a directory). */
  | { status: 'unreadable' }

/**
 * Babel plugins for a source file, derived from its extension.
 *
 * `decorators`/`decoratorAutoAccessors` are enabled everywhere. Without them a
 * single `@Injectable`-style class makes the whole file unparseable, and every
 * caller here treats an unparseable file as contributing nothing — so one
 * decorator silently hid a file's imports from `check --arch`, its class name
 * from the docs entity index, and its hazards from the deploy checks. The bare
 * `decorators` plugin accepts both `@Dec export class X` and
 * `export @Dec class X` on Babel 7.24+, so no `decoratorsBeforeExport` is needed.
 *
 * JSX is off for `.ts`/`.mts` only, so `<Type>value` cast syntax isn't misread
 * as an unterminated JSX element. Every other extension gets it: `.js`/`.mjs`
 * files in an app are far more likely to hold React JSX than angle-bracket casts.
 */
export function parserPluginsFor(filePath?: string): ParserPlugin[] {
  const base: ParserPlugin[] = ['typescript', 'decorators', 'decoratorAutoAccessors']
  if (filePath === undefined) return base
  const ext = extname(filePath)
  return ext === '.ts' || ext === '.mts' ? base : [...base, 'jsx']
}

export interface ParseSourceOptions {
  /** Selects plugins by extension. Omit for a `.ts`-equivalent parse. */
  filePath?: string
  /**
   * Force JSX on when no path is available but the source is known to be a
   * component — page-props extraction parses page sources directly.
   */
  jsx?: boolean
}

/**
 * Parse one already-read source string under the shared plugin policy.
 * Returns null when Babel rejects it.
 *
 * `errorRecovery` is deliberately absent: it makes `parse` return a partial
 * AST for broken source, which is right for the one caller that opts into it
 * (audit's model serialization scan, which would rather read a half-file than
 * nothing) and wrong for everyone else, who use "did not parse" as the signal
 * to skip the file rather than draw conclusions from a fragment.
 */
export function parseSourceFile(source: string, options: ParseSourceOptions = {}): File | null {
  const plugins = parserPluginsFor(options.filePath)
  if (options.jsx && !plugins.includes('jsx')) plugins.push('jsx')

  try {
    return parse(source, { sourceType: 'module', plugins, allowAwaitOutsideFunction: true })
  } catch {
    return null
  }
}

/**
 * Per-invocation Babel parse cache, keyed by absolute file path. Several
 * `guren check` checkers (empty-method scan, arch boundary checks) need an
 * AST for the same controller/model files; sharing one cache per `runCheck()`
 * call keeps each file read and parsed at most once instead of once per checker.
 *
 * Plugin selection is derived from the extension, not caller-supplied, so the
 * cache stays correct regardless of which checker asks first. That also means
 * the cache holds exactly one option set — a caller needing different parse
 * options (`errorRecovery`) must parse on its own rather than pass them here.
 */
export class ParseCache {
  private readonly cache = new Map<string, Promise<ParseOutcome>>()

  /** Full outcome, distinguishing an unreadable file from an unparseable one. */
  read(filePath: string): Promise<ParseOutcome> {
    let pending = this.cache.get(filePath)
    if (!pending) {
      pending = readAndParse(filePath)
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
}

async function readAndParse(filePath: string): Promise<ParseOutcome> {
  let source: string
  try {
    source = await readFile(filePath, 'utf-8')
  } catch {
    return { status: 'unreadable' }
  }

  const ast = parseSourceFile(source, { filePath })
  return ast ? { status: 'parsed', ast, source } : { status: 'unparsed', source }
}
