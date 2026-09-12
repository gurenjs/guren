/**
 * RFC 0023 Part 2's codemod: the module-level service slots become container
 * resolution. Each rule is one row of the RFC's Migration Path table, applied
 * to the whole accessor family, since the shape is what it recognises.
 * Anything the table marks "reported" is left alone and reaches the author
 * through `deprecations.ts` instead.
 *
 * Rewrites are offset splices applied back to front, so one rule never
 * invalidates another's positions.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { relative } from 'node:path'
import type { Node } from '@babel/types'
import { type BabelNode, memberKeyName, unwrapTypeAssertion, walk } from './ast-walk'
import { discoverAppConfigFiles } from './discovery'
import { parseSourceFile } from './parse-cache'

/** Deprecated getter → the container key it resolved. */
const GETTER_KEYS: Record<string, string> = {
  getGate: 'gate',
  getEncrypter: 'encrypter',
  getMailManager: 'mail',
  getI18n: 'i18n',
  getLogManager: 'log',
  getNotificationManager: 'notifications',
  getBroadcastManager: 'broadcast',
  getExceptionHandler: 'exception.handler',
}

/**
 * Deprecated setter → the container key it wrote. `setQueueDriver` is absent on
 * purpose: through Part 2 the pin still overrides the bound manager, so binding
 * the key is not the same instruction.
 */
const SETTER_KEYS: Record<string, string> = {
  setGate: 'gate',
  setEncrypter: 'encrypter',
  setMailManager: 'mail',
  setI18n: 'i18n',
  setLogManager: 'log',
  setNotificationManager: 'notifications',
  setBroadcastManager: 'broadcast',
  setExceptionHandler: 'exception.handler',
}

const BINDING_METHODS = new Set(['instance', 'bind', 'singleton'])

/** Cheap pre-filter: parsing every app source to find nothing is the common case. */
const MENTIONS = new RegExp(
  `\\b(?:getContainer|setInertiaDocument|${Object.keys(GETTER_KEYS).join('|')}|${Object.keys(SETTER_KEYS).join('|')})\\b`,
)

interface Range {
  start: number
  end: number
}

interface Edit extends Range {
  text: string
  /** An identifier this edit consumes, so an import specifier can be judged unused. */
  consumes?: Range
}

function nodeRange(node: BabelNode | Node | undefined | null): Range | null {
  if (!node) return null
  const start = (node as { start?: number | null }).start
  const end = (node as { end?: number | null }).end
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null
}

function contains(outer: Range, inner: Range): boolean {
  return inner.start >= outer.start && inner.end <= outer.end
}

function enclosing(ranges: Range[], node: Range): Range | undefined {
  return ranges.find((range) => contains(range, node))
}

function superClassName(node: BabelNode): string | undefined {
  const superClass = node.superClass as BabelNode | undefined
  return superClass?.type === 'Identifier' ? (superClass.name as string) : undefined
}

/** A call of `name` with no arguments. */
function isPlainCall(node: BabelNode, name: string): boolean {
  const callee = node.callee as BabelNode | undefined
  return (
    node.type === 'CallExpression'
    && callee?.type === 'Identifier'
    && callee.name === name
    && (node.arguments as unknown[]).length === 0
  )
}

/** The key a `container.instance('key', …)`-shaped call binds, if any. */
function boundKey(node: BabelNode): string | undefined {
  if (node.type !== 'CallExpression') return undefined
  const callee = node.callee as BabelNode | undefined
  if (callee?.type !== 'MemberExpression') return undefined
  const property = callee.property as BabelNode | undefined
  if (property?.type !== 'Identifier' || !BINDING_METHODS.has(property.name as string)) return undefined
  const first = (node.arguments as BabelNode[])[0]
  return first?.type === 'StringLiteral' ? (first.value as string) : undefined
}

function lineStartAt(source: string, offset: number): number {
  return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
}

/**
 * A statement's span widened to whole lines and to the `//` comment lines
 * written directly above it: a deleted statement must not leave the comment
 * that explained it pointing at the next one.
 */
function statementSpan(source: string, range: Range): Range {
  let start = lineStartAt(source, range.start)
  while (start > 0) {
    const previous = lineStartAt(source, start - 1)
    if (!source.slice(previous, start - 1).trim().startsWith('//')) break
    start = previous
  }
  const lineEnd = source.indexOf('\n', range.end)
  let end = lineEnd < 0 ? source.length : lineEnd + 1
  // A statement between two blank lines leaves one behind, not two.
  if (source[end] === '\n' && source.slice(Math.max(0, start - 2), start) === '\n\n') end += 1
  return { start, end }
}

function applyEdits(source: string, edits: Edit[]): string {
  let result = source
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}

/**
 * `source` with every Migration Path rewrite applied, or null when the file
 * needs none. `detect()` and `apply()` both answer from this, so a file
 * `--dry-run` lists is exactly a file `guren upgrade` writes.
 */
export function transformSource(source: string, filePath: string): string | null {
  if (!MENTIONS.test(source)) return null
  const ast = parseSourceFile(source, filePath)
  if (!ast) return null

  const providers: Range[] = []
  const jobs: Range[] = []
  walk(ast.program, (node) => {
    if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return
    const range = nodeRange(node)
    if (!range) return
    const parent = superClassName(node)
    if (parent === 'ServiceProvider') providers.push(range)
    else if (parent === 'Job') jobs.push(range)
  })

  const edits: Edit[] = [
    ...getterEdits(ast.program, providers, jobs),
    ...setterEdits(ast.program, source, providers),
    ...storageFactoryEdits(ast.program, source),
    ...inertiaDocumentEdits(ast.program, source),
  ]
  if (edits.length === 0) return null

  edits.push(...unusedImportEdits(ast.program, source, edits))
  return applyEdits(source, edits)
}

/** Rows 1 and 6: a deprecated getter inside a provider or a job. */
function getterEdits(program: unknown, providers: Range[], jobs: Range[]): Edit[] {
  const edits: Edit[] = []
  walk(program, (node) => {
    if (node.type !== 'CallExpression') return
    const range = nodeRange(node)
    const callee = nodeRange(node.callee as BabelNode)
    if (!range || !callee) return

    for (const [name, key] of Object.entries(GETTER_KEYS)) {
      if (!isPlainCall(node, name)) continue
      if (enclosing(providers, range)) {
        edits.push({ ...range, text: `this.container.make('${key}')`, consumes: callee })
      }
      return
    }

    if (!isPlainCall(node, 'getContainer')) return
    if (enclosing(providers, range)) {
      edits.push({ ...range, text: 'this.container', consumes: callee })
      return
    }
    // A job holds its container privately, so only the resolution wrapped
    // around the call can be rewritten: `getContainer().make(k)` is
    // `this.make(k)`. A bare `getContainer()` in a job is reported instead.
    if (enclosing(jobs, range)) {
      edits.push({ ...range, text: 'this', consumes: callee })
    }
  })
  return edits
}

/** Rows 2 and 3: a deprecated setter inside a provider. */
function setterEdits(program: unknown, source: string, providers: Range[]): Edit[] {
  const edits: Edit[] = []
  walk(program, (node) => {
    if (node.type !== 'ExpressionStatement') return
    const call = unwrapTypeAssertion(node.expression as Node) as BabelNode
    const callee = call?.type === 'CallExpression' ? (call.callee as BabelNode) : undefined
    if (callee?.type !== 'Identifier') return
    const key = SETTER_KEYS[callee.name as string]
    if (!key) return

    const statement = nodeRange(node)
    const callRange = nodeRange(call)
    const calleeRange = nodeRange(callee)
    const args = call.arguments as BabelNode[]
    const argument = nodeRange(args[0])
    if (!statement || !callRange || !calleeRange || args.length !== 1 || !argument) return

    // A provider in this file already binds the key, so the call was writing the
    // same value twice and the container half is the one that survives. Judged
    // per file rather than per class: the blog example's call sits in a
    // module-scope helper its provider invokes, which is the common shape.
    if (providers.some((provider) => classBinds(program, provider, key))) {
      edits.push({ ...statementSpan(source, statement), text: '', consumes: calleeRange })
      return
    }

    if (!enclosing(providers, callRange)) return

    edits.push({
      ...callRange,
      text: `this.container.instance('${key}', ${source.slice(argument.start, argument.end)})`,
      consumes: calleeRange,
    })
  })
  return edits
}

/** Whether the class at `range` binds `key` on a container of its own. */
function classBinds(program: unknown, range: Range, key: string): boolean {
  let found = false
  walk(program, (node) => {
    if (found) return false
    const nodeAt = nodeRange(node)
    if (!nodeAt || !contains(range, nodeAt)) return
    if (boundKey(node) === key) found = true
  })
  return found
}

/** Row 5: `configureAttachments({ storage: () => getContainer().make('storage') })`. */
function storageFactoryEdits(program: unknown, source: string): Edit[] {
  const edits: Edit[] = []
  walk(program, (node) => {
    if (node.type !== 'CallExpression') return
    const callee = node.callee as BabelNode | undefined
    if (callee?.type !== 'Identifier' || callee.name !== 'configureAttachments') return
    const options = unwrapTypeAssertion((node.arguments as Node[])[0]) as BabelNode | undefined
    if (options?.type !== 'ObjectExpression') return

    for (const property of options.properties as BabelNode[]) {
      if (property.type !== 'ObjectProperty' || memberKeyName(property as never) !== 'storage') continue
      const arrow = unwrapTypeAssertion(property.value as Node) as BabelNode
      const arrowRange = nodeRange(arrow)
      if (arrow?.type !== 'ArrowFunctionExpression' || !arrowRange) continue
      if ((arrow.params as unknown[]).length !== 0) continue

      const inner: Edit[] = []
      walk(arrow.body, (child) => {
        if (!isPlainCall(child, 'getContainer')) return
        const range = nodeRange(child)
        if (range) inner.push({ ...range, text: 'container', consumes: nodeRange(child.callee as BabelNode) ?? undefined })
      })
      if (inner.length === 0) continue

      // The parameter list is the arrow's own `()`, which `async` can precede.
      const open = source.indexOf('(', arrowRange.start)
      if (open < 0 || open >= arrowRange.end || source.slice(open, open + 2) !== '()') continue
      edits.push({ start: open, end: open + 2, text: '(container)' }, ...inner)
    }
  })
  return edits
}

/** Row 4: `setInertiaDocument({…})` at module scope beside a `createApp({…})`. */
function inertiaDocumentEdits(program: unknown, source: string): Edit[] {
  const body = (program as { body?: BabelNode[] }).body ?? []

  const options = createAppOptions(program)
  if (!options) return []

  for (const statement of body) {
    if (statement.type !== 'ExpressionStatement') continue
    const call = unwrapTypeAssertion(statement.expression as Node) as BabelNode
    if (!call || call.type !== 'CallExpression') continue
    const callee = call.callee as BabelNode | undefined
    if (callee?.type !== 'Identifier' || callee.name !== 'setInertiaDocument') continue

    const literal = unwrapTypeAssertion((call.arguments as Node[])[0]) as BabelNode | undefined
    const literalRange = nodeRange(literal)
    const statementRange = nodeRange(statement)
    if (literal?.type !== 'ObjectExpression' || !literalRange || !statementRange) continue

    const span = statementSpan(source, statementRange)
    const comment = source
      .slice(span.start, lineStartAt(source, statementRange.start))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => `  ${line.trim()}\n`)
      .join('')

    return [
      { ...span, text: '', consumes: nodeRange(callee) ?? undefined },
      {
        start: options.start + 1,
        end: options.start + 1,
        text: `\n${comment}  inertia: {\n    document: ${indentLiteral(source.slice(literalRange.start, literalRange.end))},\n  },`,
      },
    ]
  }
  return []
}

/**
 * The `createApp({…})` options object this module passes, when it has no
 * `inertia` key yet. A call that already carries one is reported rather than
 * merged: the two values would have to be reconciled by a reader.
 */
function createAppOptions(program: unknown): Range | null {
  let found: Range | null = null
  walk(program, (node) => {
    if (found || node.type !== 'CallExpression') return
    const callee = node.callee as BabelNode | undefined
    if (callee?.type !== 'Identifier' || callee.name !== 'createApp') return
    const options = unwrapTypeAssertion((node.arguments as Node[])[0]) as BabelNode | undefined
    if (options?.type !== 'ObjectExpression') return
    const keys = (options.properties as BabelNode[])
      .map((property) => (property.type === 'ObjectProperty' ? memberKeyName(property as never) : undefined))
    if (keys.includes('inertia')) return
    found = nodeRange(options)
  })
  return found
}

/**
 * A literal moved two levels deeper keeps its own line breaks and gains four
 * columns. Skipped where a backtick appears: indentation inside a template
 * literal is content, not layout.
 */
function indentLiteral(literal: string): string {
  if (!literal.includes('\n') || literal.includes('`')) return literal
  const [first, ...rest] = literal.split('\n')
  return [first, ...rest.map((line) => (line.trim().length === 0 ? line : `    ${line}`))].join('\n')
}

/**
 * Import specifiers whose every reference this pass removed. Judged on the
 * offsets the edits consume rather than on the rewritten text, so a name the
 * file still uses elsewhere keeps its import.
 */
function unusedImportEdits(program: unknown, source: string, edits: Edit[]): Edit[] {
  const consumed = edits.map((edit) => edit.consumes).filter((range): range is Range => Boolean(range))
  if (consumed.length === 0) return []

  const references = new Map<string, Range[]>()
  const declarations: { range: Range; specifiers: { name: string; range: Range }[] }[] = []

  for (const statement of (program as { body?: BabelNode[] }).body ?? []) {
    if (statement.type !== 'ImportDeclaration') continue
    const sourceValue = (statement.source as BabelNode).value
    if (sourceValue !== '@guren/core' && sourceValue !== '@guren/server') continue
    const range = nodeRange(statement)
    if (!range) continue
    const specifiers = (statement.specifiers as BabelNode[])
      .filter((specifier) => specifier.type === 'ImportSpecifier')
      .map((specifier) => ({
        name: ((specifier.local as BabelNode).name as string),
        range: nodeRange(specifier) as Range,
      }))
      .filter((specifier) => specifier.range)
    if (specifiers.length > 0) declarations.push({ range, specifiers })
  }
  if (declarations.length === 0) return []

  const importRanges = declarations.map((declaration) => declaration.range)
  walk(program, (node) => {
    if (node.type !== 'Identifier') return
    const range = nodeRange(node)
    if (!range || enclosing(importRanges, range)) return
    const name = node.name as string
    references.set(name, [...(references.get(name) ?? []), range])
  })

  const removals: Edit[] = []
  for (const declaration of declarations) {
    const dropped = declaration.specifiers.filter((specifier) =>
      (references.get(specifier.name) ?? []).every((reference) =>
        consumed.some((range) => contains(range, reference)),
      ),
    )
    if (dropped.length === 0) continue

    if (dropped.length === declaration.specifiers.length) {
      removals.push({ ...statementSpan(source, declaration.range), text: '' })
      continue
    }
    for (const specifier of dropped) {
      removals.push({ ...widenSpecifier(source, specifier.range), text: '' })
    }
  }
  return removals
}

/** A specifier's span plus the separator that joined it to its neighbour. */
function widenSpecifier(source: string, range: Range): Range {
  const lineStart = lineStartAt(source, range.start)
  const lineEnd = source.indexOf('\n', range.end)
  const rest = source.slice(range.end, lineEnd < 0 ? source.length : lineEnd)
  // One specifier per line takes its whole line; anything else on the line
  // means the comma, not the newline, is what joined it to its neighbour.
  if (source.slice(lineStart, range.start).trim() === '' && rest.trim().replace(',', '') === '') {
    return { start: lineStart, end: lineEnd < 0 ? source.length : lineEnd + 1 }
  }

  let end = range.end
  while (/[ \t]/.test(source[end] ?? '')) end += 1
  if (source[end] === ',') {
    end += 1
    while (/[ \t]/.test(source[end] ?? '')) end += 1
    return { start: range.start, end }
  }

  let start = range.start
  while (start > 0 && /[ \t]/.test(source[start - 1])) start -= 1
  if (source[start - 1] === ',') start -= 1
  return { start, end: range.end }
}

/** Files the codemod would rewrite, relative to `cwd`. */
export async function detectContainerResolution(cwd: string): Promise<string[]> {
  const files = await discoverAppConfigFiles(cwd)
  const affected = await Promise.all(
    files.map(async (filePath) => {
      const source = await readFile(filePath, 'utf-8').catch(() => null)
      if (source === null) return null
      return transformSource(source, filePath) === null ? null : relative(cwd, filePath)
    }),
  )
  return affected.filter((file): file is string => file !== null)
}

/** Applies the rewrites; answers how many files changed. */
export async function applyContainerResolution(cwd: string): Promise<number> {
  const files = await discoverAppConfigFiles(cwd)
  let changed = 0
  for (const filePath of files) {
    const source = await readFile(filePath, 'utf-8').catch(() => null)
    if (source === null) continue
    const next = transformSource(source, filePath)
    if (next === null) continue
    await writeFile(filePath, next, 'utf-8')
    changed += 1
  }
  return changed
}
