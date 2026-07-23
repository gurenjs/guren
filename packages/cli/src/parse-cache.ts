import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'
import type { File } from '@babel/types'

export interface ParsedFile {
  ast: File
  source: string
}

/**
 * Per-invocation Babel parse cache, keyed by absolute file path. Several
 * `guren check` checkers (empty-method scan, arch boundary checks) need an
 * AST for the same controller/model files; sharing one cache per `runCheck()`
 * call keeps each file parsed at most once instead of once per checker.
 *
 * Plugin selection is derived from the extension, not caller-supplied — a
 * `.ts` file is parsed without the `jsx` plugin (so `<Type>value` cast
 * syntax isn't misread as JSX) while `.tsx`/`.jsx` enable it. This keeps the
 * cache correct regardless of which checker asks first.
 */
export class ParseCache {
  private readonly cache = new Map<string, Promise<ParsedFile | null>>()

  get(filePath: string): Promise<ParsedFile | null> {
    let pending = this.cache.get(filePath)
    if (!pending) {
      pending = parseFile(filePath)
      this.cache.set(filePath, pending)
    }
    return pending
  }
}

async function parseFile(filePath: string): Promise<ParsedFile | null> {
  let source: string
  try {
    source = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }

  const isJsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')

  try {
    const ast = parse(source, {
      sourceType: 'module',
      plugins: isJsx ? ['typescript', 'jsx'] : ['typescript'],
    })
    return { ast, source }
  } catch {
    return null
  }
}
