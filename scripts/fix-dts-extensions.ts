/**
 * Rewrites extensionless relative import specifiers in emitted .d.ts files to
 * explicit .js specifiers (./foo -> ./foo.js, ./dir -> ./dir/index.js).
 * Usage: bun scripts/fix-dts-extensions.ts <distDir>
 *
 * `tsc --emitDeclarationOnly` preserves source specifiers verbatim, but an ESM
 * package's declarations must be runtime-resolvable for consumers on
 * `moduleResolution: node16`/`nodenext` (TS maps the .js specifier back to the
 * sibling .d.ts). Bundler-resolution consumers accept both forms.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parse } from '@babel/parser'
import * as t from '@babel/types'

import { walk } from '../packages/cli/src/ast-walk'

function collectDtsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectDtsFiles(full, out)
    else if (entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function resolveRewrite(filePath: string, specifier: string): string | null {
  const isRelative =
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  if (!isRelative) return null
  if (/\.(js|mjs|cjs|json)$/.test(specifier)) return null
  const base = resolve(dirname(filePath), specifier)
  if (existsSync(`${base}.d.ts`)) return `${specifier}.js`
  if (existsSync(join(base, 'index.d.ts'))) return `${specifier}/index.js`
  throw new Error(`fix-dts-extensions: cannot resolve '${specifier}' from ${filePath}`)
}

function collectSpecifierNodes(text: string, filePath: string): t.StringLiteral[] {
  const ast = parse(text, {
    sourceType: 'module',
    sourceFilename: filePath,
    // Declarations can carry decorators and `accessor` fields; without these
    // plugins Babel throws on them where the old TypeScript parser did not.
    plugins: [['typescript', { dts: true }], 'decorators', 'decoratorAutoAccessors'],
  })
  const literals: t.StringLiteral[] = []
  walk(ast, (node) => {
    const n = node as unknown as t.Node
    if (
      (t.isImportDeclaration(n) || t.isExportNamedDeclaration(n) || t.isExportAllDeclaration(n)) &&
      n.source != null
    ) {
      literals.push(n.source)
    } else if (t.isTSImportType(n) && t.isStringLiteral(n.argument)) {
      literals.push(n.argument)
    } else if (t.isCallExpression(n) && t.isImport(n.callee) && n.arguments.length === 1 && t.isStringLiteral(n.arguments[0])) {
      literals.push(n.arguments[0])
    }
  })
  return literals
}

const distDir = resolve(process.argv[2] ?? 'dist')
let rewrittenFiles = 0

for (const filePath of collectDtsFiles(distDir)) {
  const text = readFileSync(filePath, 'utf8')
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  for (const literal of collectSpecifierNodes(text, filePath)) {
    const rewritten = resolveRewrite(filePath, literal.value)
    if (rewritten === null) continue
    if (literal.start == null || literal.end == null) {
      throw new Error(`fix-dts-extensions: specifier without a source range in ${filePath}`)
    }
    // Replace only the contents between the quotes.
    edits.push({ start: literal.start + 1, end: literal.end - 1, replacement: rewritten })
  }
  if (edits.length === 0) continue
  let updated = text
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end)
  }
  writeFileSync(filePath, updated)
  rewrittenFiles += 1
}

console.log(`fix-dts-extensions: rewrote relative specifiers in ${rewrittenFiles} file(s) under ${distDir}`)
