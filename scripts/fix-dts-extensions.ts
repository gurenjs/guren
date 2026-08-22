/**
 * Rewrites extensionless relative import specifiers in emitted .d.ts files to
 * explicit .js specifiers (./foo -> ./foo.js, ./dir -> ./dir/index.js).
 *
 * `tsc --emitDeclarationOnly` preserves source specifiers verbatim, but
 * declaration files in an ESM package must use runtime-resolvable specifiers
 * for consumers on `moduleResolution: node16`/`nodenext` (TS maps the .js
 * specifier back to the sibling .d.ts). Bundler-resolution consumers accept
 * both forms.
 *
 * Usage: bun scripts/fix-dts-extensions.ts <distDir>
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parse } from '@babel/parser'
import * as t from '@babel/types'

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

/** String-literal specifier nodes: import/export declarations and import types. */
function collectSpecifierNodes(text: string, filePath: string): t.StringLiteral[] {
  const ast = parse(text, {
    sourceType: 'module',
    sourceFilename: filePath,
    plugins: [['typescript', { dts: true }]],
  })
  const literals: t.StringLiteral[] = []
  const visit = (node: t.Node): void => {
    if (
      (t.isImportDeclaration(node) || t.isExportNamedDeclaration(node) || t.isExportAllDeclaration(node)) &&
      node.source != null
    ) {
      literals.push(node.source)
    } else if (t.isTSImportType(node) && t.isStringLiteral(node.argument)) {
      literals.push(node.argument)
    } else if (
      t.isCallExpression(node) &&
      t.isImport(node.callee) &&
      node.arguments.length === 1 &&
      t.isStringLiteral(node.arguments[0])
    ) {
      literals.push(node.arguments[0])
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, t.Node | t.Node[] | null | undefined>)[key]
      if (Array.isArray(child)) {
        for (const item of child) if (item) visit(item)
      } else if (child) {
        visit(child)
      }
    }
  }
  visit(ast)
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
