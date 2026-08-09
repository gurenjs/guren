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

import ts from 'typescript'

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
function collectSpecifierNodes(sourceFile: ts.SourceFile): ts.StringLiteral[] {
  const literals: ts.StringLiteral[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      literals.push(node.moduleSpecifier)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      literals.push(node.argument.literal)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      literals.push(node.arguments[0] as ts.StringLiteral)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return literals
}

const distDir = resolve(process.argv[2] ?? 'dist')
let rewrittenFiles = 0

for (const filePath of collectDtsFiles(distDir)) {
  const text = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true)
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  for (const literal of collectSpecifierNodes(sourceFile)) {
    const rewritten = resolveRewrite(filePath, literal.text)
    if (rewritten === null) continue
    // Replace only the contents between the quotes.
    edits.push({
      start: literal.getStart(sourceFile) + 1,
      end: literal.getEnd() - 1,
      replacement: rewritten,
    })
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
