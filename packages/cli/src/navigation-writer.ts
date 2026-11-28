/**
 * The one writer of `config/navigation.ts` (RFC 0040 §5): `appendNavigationEntry()` and its
 * counterpart, edits to the source text that `readNavigationFile()` must read back as exactly the
 * entries before plus or minus one, else nothing is written. `guren nav:add` and `nav:remove`
 * call them, as does `make:feature` for its index page; a plan's `commands` go through them too.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { File, ImportDeclaration, ImportSpecifier, Node } from '@babel/types'

import { CliError } from './cli-error'
import { withFileLock } from './file-lock'
import { navigationEntryList, readNavigationFile, type NavigationFileAuth, type NavigationFileEntry } from './navigation-file'
import { parseSourceFile } from './parse-cache'
import { writeFileAtomic } from './plan/beside'
import { specifierBase, withoutExtension } from './schema-binding'

export const NAVIGATION_FILE = 'config/navigation.ts'

export interface NavigationEntryInput {
  label: string
  route: string
  auth?: NavigationFileAuth
  /** The ability and the root model class: `app/Models/<model>.ts` must export it. */
  can?: { ability: string; model: string }
}

const MODEL_NAME = /^[A-Z][A-Za-z0-9_]*$/u
// What a string literal in the file may hold without an escape the reader would read otherwise.
const PLAIN_TEXT = /^[^\p{Cc}\p{Zl}\p{Zp}]*$/u

const modelSpecifier = (model: string): string => `@/app/Models/${model}`
const modelModule = (cwd: string, model: string): string => resolve(cwd, 'app/Models', model)
const eolOf = (source: string): string => (source.includes('\r\n') ? '\r\n' : '\n')
// What may follow on a line after an entry or an import and stay on it: blanks, then a line comment.
const LINE_TAIL = /^[ \t]*(?:\/\/[^\r\n]*)?\r?\n?$/u

function parse(source: string, file: string): File {
  const ast = parseSourceFile(source, file)
  if (ast === null) throw new CliError(`${NAVIGATION_FILE} does not parse.`)
  return ast
}

function readEntries(ast: File, cwd: string): NavigationFileEntry[] {
  const reading = readNavigationFile(ast, { cwd, file: resolve(cwd, NAVIGATION_FILE) })
  if (reading.status === 'not-a-definition') throw new CliError(`${NAVIGATION_FILE} is not a defineNavigation() definition.`)
  if (reading.status === 'unreadable') {
    throw new CliError(`${NAVIGATION_FILE}${reading.line ? `:${reading.line}` : ''} cannot be read as data (${reading.reason}), so it is not edited.`)
  }
  return reading.entries
}

const quote = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

function checkInput(input: NavigationEntryInput): void {
  if (input.label.trim() === '') throw new CliError('The label is empty.')
  if (input.route === '') throw new CliError('The route name is empty.')
  for (const [what, value] of [['label', input.label], ['route name', input.route], ['ability', input.can?.ability ?? '']] as const) {
    if (!PLAIN_TEXT.test(value)) throw new CliError(`The ${what} holds a line break or a control character.`)
  }
  if (input.can) {
    if (input.can.ability === '') throw new CliError('--can names no ability: write it as <ability>:<Model>, such as create:Job.')
    if (!MODEL_NAME.test(input.can.model)) throw new CliError(`--can names "${input.can.model}", which is no class name: write it as <ability>:<Model>, such as create:Job.`)
  }
}

function renderEntry(input: NavigationEntryInput): string {
  const show: string[] = []
  if (input.auth !== undefined) show.push(`auth: ${quote(input.auth)}`)
  if (input.can) show.push(`can: [${quote(input.can.ability)}, ${input.can.model}]`)
  const fields = [`label: ${quote(input.label)}`, `route: ${quote(input.route)}`]
  if (show.length > 0) fields.push(`show: { ${show.join(', ')} }`)
  return `{ ${fields.join(', ')} }`
}

const lineStart = (source: string, offset: number): number => source.lastIndexOf('\n', offset - 1) + 1
const indentAt = (source: string, offset: number): string => /^[ \t]*/u.exec(source.slice(lineStart(source, offset)))![0]
const span = (node: Node): { start: number; end: number } => ({ start: node.start!, end: node.end! })

/** An element's span with the parentheses around it, which Babel records beside the node rather than in its span. */
function elementSpan(source: string, node: Node): { start: number; end: number } {
  const parenStart = (node.extra as { parenStart?: number } | undefined)?.parenStart
  if (parenStart === undefined) return span(node)
  let end = node.end!
  for (let open = (source.slice(parenStart, node.start!).match(/\(/gu) ?? []).length; open > 0; open -= 1) {
    const close = /^\s*\)/u.exec(source.slice(end))
    if (close === null) return span(node)
    end += close[0].length
  }
  return { start: parenStart, end }
}

/** The offset just past a comma that follows `offset` across whitespace alone, else undefined. */
function commaAfter(source: string, offset: number, limit: number): number | undefined {
  const match = /^\s*,/u.exec(source.slice(offset, limit))
  return match ? offset + match[0].length : undefined
}

function insertEntry(source: string, ast: File, entry: string): string {
  const list = navigationEntryList(ast)!
  const { start, end } = span(list)
  const elements = list.elements as Node[]
  const last = elements.at(-1)
  const eol = eolOf(source)
  if (last === undefined) {
    const inside = source.slice(start + 1, end - 1)
    const indent = indentAt(source, start)
    if (inside.trim() === '') return `${source.slice(0, start)}[${eol}${indent}  ${entry},${eol}${indent}]${source.slice(end)}`
    // An empty list that holds a comment keeps it: the entry goes before the closing bracket.
    const close = end - 1
    if (source.slice(lineStart(source, close), close).trim() === '') {
      const at = lineStart(source, close)
      return `${source.slice(0, at)}${indentAt(source, close)}  ${entry},${eol}${source.slice(at)}`
    }
    return `${source.slice(0, close)}${/\s$/u.test(source.slice(0, close)) ? '' : ' '}${entry} ${source.slice(close)}`
  }
  const lastSpan = elementSpan(source, last)
  const lastEnd = lastSpan.end
  const sameLine = !source.slice(start, lastSpan.start).includes('\n')
  const comma = commaAfter(source, lastEnd, end - 1)
  if (sameLine) {
    return comma === undefined
      ? `${source.slice(0, lastEnd)}, ${entry}${source.slice(lastEnd)}`
      : `${source.slice(0, comma)} ${entry},${source.slice(comma)}`
  }
  const indent = indentAt(source, lastSpan.start)
  // A comment closing the last entry's line stays on that line.
  const after = comma ?? lastEnd
  const lineEnd = source.indexOf('\n', after)
  const rest = source.slice(after, lineEnd === -1 ? end - 1 : lineEnd + 1)
  const tailEnd = lineEnd !== -1 && source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd
  const at = lineEnd !== -1 && lineEnd < end && LINE_TAIL.test(rest) ? tailEnd : after
  const head = comma === undefined ? `${source.slice(0, lastEnd)},${source.slice(lastEnd, at)}` : source.slice(0, at)
  return `${head}${eol}${indent}${entry}${comma === undefined ? '' : ','}${source.slice(at)}`
}

/** The text with one range cut, widened to whole lines when nothing else shares them. */
function cut(source: string, from: number, to: number): string {
  const start = lineStart(source, from)
  const lineEnd = source.indexOf('\n', to)
  const end = lineEnd === -1 ? source.length : lineEnd + 1
  // A comment closing the line goes with what it closed.
  if (source.slice(start, from).trim() === '' && LINE_TAIL.test(source.slice(to, end))) return source.slice(0, start) + source.slice(end)
  return source.slice(0, from) + source.slice(to).replace(/^[ \t]*/u, '')
}

function cutEntry(source: string, ast: File, route: string, entries: NavigationFileEntry[]): string {
  const list = navigationEntryList(ast)!
  const elements = list.elements as Node[]
  const index = entries.findIndex((entry) => entry.route === route)
  const element = elements[index]!
  const { start, end } = elementSpan(source, element)
  const comma = commaAfter(source, end, span(list).end - 1)
  if (elements.length === 1) {
    const inside = source.slice(span(list).start + 1, start) + source.slice(comma ?? end, span(list).end - 1)
    if (inside.trim() === '') return `${source.slice(0, span(list).start)}[]${source.slice(span(list).end)}`
  }
  if (comma !== undefined) return cut(source, start, comma)
  const previous = elements[index - 1]
  if (previous === undefined) return cut(source, start, end)
  // The last entry and no trailing comma: the comma before it goes with it.
  const previousEnd = elementSpan(source, previous).end
  const previousComma = commaAfter(source, previousEnd, start)
  if (previousComma === undefined) return cut(source, start, end)
  if (!source.slice(previousEnd, start).includes('\n')) return source.slice(0, previousEnd) + source.slice(end)
  const joined = cut(source, start, end)
  return joined.slice(0, previousEnd) + joined.slice(previousComma)
}

const importsOf = (ast: File): ImportDeclaration[] =>
  ast.program.body.filter((statement): statement is ImportDeclaration => statement.type === 'ImportDeclaration')

/** Whether the file before the edit needs the model's import, refusing a name it already binds to something else. */
function needsModelImport(ast: File, model: string, cwd: string): boolean {
  for (const declaration of importsOf(ast)) {
    for (const specifier of declaration.specifiers) {
      if (specifier.local.name !== model) continue
      const resolved = specifierBase(cwd, resolve(cwd, NAVIGATION_FILE), declaration.source.value)
      const sameFile = resolved !== null && withoutExtension(resolved) === modelModule(cwd, model)
      const named = specifier.type === 'ImportSpecifier' && specifierImports(specifier) === model
      const value = declaration.importKind !== 'type' && !(specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
      if (sameFile && named && value) return false
      throw new CliError(sameFile
        ? `${NAVIGATION_FILE} imports ${model} from ${declaration.source.value}, but not as the class's named value export; import it as { ${model} } first.`
        : `${NAVIGATION_FILE} already imports a ${model} from ${declaration.source.value}, which is not app/Models/${model}.`)
    }
  }
  const body = ast.program.body.filter((statement) => statement.type !== 'ImportDeclaration')
  if (namesIdentifier(body, model)) throw new CliError(`${NAVIGATION_FILE} already names a ${model} that is not the model.`)
  return true
}

const specifierImports = (specifier: ImportSpecifier): string =>
  specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value

function addModelImport(source: string, ast: File, model: string): string {
  const eol = eolOf(source)
  const line = `import { ${model} } from '${modelSpecifier(model)}'`
  const lastImport = importsOf(ast).at(-1)
  if (lastImport === undefined) return `${line}${eol}${source}`
  // Right after the statement, on a line of its own: what shares the import's line may open a comment.
  const end = span(lastImport).end
  const lineEnd = source.indexOf('\n', end)
  const rest = lineEnd === -1 ? source.slice(end) : source.slice(end, lineEnd + 1)
  if (LINE_TAIL.test(rest)) {
    const at = lineEnd === -1 ? source.length : lineEnd + 1
    return `${source.slice(0, at)}${lineEnd === -1 ? eol : ''}${line}${eol}${source.slice(at)}`
  }
  return `${source.slice(0, end)}${eol}${line}${eol}${source.slice(end).replace(/^[ \t]*/u, '')}`
}

/** Whether any identifier in the tree is `name`, types included: a type-only use still needs the import. */
function namesIdentifier(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((child) => namesIdentifier(child, name))
  if (node === null || typeof node !== 'object') return false
  const record = node as { type?: unknown; name?: unknown }
  if (record.type === 'Identifier' && record.name === name) return true
  return Object.entries(node).some(([key, child]) => key !== 'loc' && key !== 'leadingComments' && key !== 'trailingComments' && namesIdentifier(child, name))
}

function removeUnusedImport(source: string, model: string, cwd: string): string {
  const ast = parse(source, resolve(cwd, NAVIGATION_FILE))
  const declaration = ast.program.body.find(
    (statement): statement is ImportDeclaration => statement.type === 'ImportDeclaration' && statement.specifiers.some((specifier) => specifier.local.name === model),
  )
  if (declaration === undefined) return source
  const rest = ast.program.body.filter((statement) => statement !== declaration)
  if (namesIdentifier(rest, model)) return source
  if (declaration.specifiers.length === 1) return cut(source, span(declaration).start, span(declaration).end)
  const specifier = declaration.specifiers.find((candidate) => candidate.local.name === model)!
  const named = declaration.specifiers.filter((candidate): candidate is ImportSpecifier => candidate.type === 'ImportSpecifier')
  if (specifier.type === 'ImportDefaultSpecifier') {
    // `import Job, { other }`: the default and its comma go.
    const comma = commaAfter(source, span(specifier).end, span(declaration).end)
    return comma === undefined ? source : source.slice(0, span(specifier).start) + source.slice(comma).replace(/^[ \t]*/u, '')
  }
  if (specifier.type === 'ImportNamespaceSpecifier') {
    // `import Other, * as Models`: the comma before it goes with it.
    const previous = declaration.specifiers[declaration.specifiers.indexOf(specifier) - 1]
    return previous === undefined ? source : source.slice(0, span(previous).end) + source.slice(span(specifier).end)
  }
  if (named.length === 1) {
    // `import Other, { Job }`: the braces go with their one name.
    const open = source.lastIndexOf('{', span(specifier).start)
    const close = source.indexOf('}', span(specifier).end)
    const before = source.lastIndexOf(',', open)
    if (open === -1 || close === -1 || before === -1) return source
    return source.slice(0, before) + source.slice(close + 1)
  }
  const index = named.indexOf(specifier)
  const next = named[index + 1]
  if (next !== undefined) return source.slice(0, span(specifier).start) + source.slice(span(next).start)
  return source.slice(0, span(named[index - 1]!).end) + source.slice(span(specifier).end)
}

const sameEntry = (entry: NavigationFileEntry, input: NavigationEntryInput, cwd: string): boolean =>
  entry.label === input.label &&
  entry.route === input.route &&
  entry.auth === input.auth &&
  entry.where === undefined &&
  entry.can?.ability === input.can?.ability &&
  entry.can?.model.className === input.can?.model &&
  // The import half of the edit: the class must resolve to the model's file.
  (input.can === undefined || entry.can?.model.module === modelModule(cwd, input.can.model))

const comparable = (entry: NavigationFileEntry): string => JSON.stringify({ ...entry, line: undefined })

const READ_BACK_FAILED = `The edit to ${NAVIGATION_FILE} would not read back as intended, so nothing was written. Edit the file by hand.`

/** An edit of the file's text, any failure of which is the writer's, not the file's. */
function edit(make: () => string): string {
  try {
    return make()
  } catch (error) {
    if (error instanceof CliError) throw new CliError(READ_BACK_FAILED)
    throw error
  }
}

function readBack(source: string, cwd: string, expected: NavigationFileEntry[], added?: NavigationEntryInput): void {
  const entries = readEntries(parse(source, resolve(cwd, NAVIGATION_FILE)), cwd)
  const kept = added === undefined ? entries : entries.slice(0, -1)
  const fresh = added === undefined ? undefined : entries.at(-1)
  const holds =
    kept.length === expected.length &&
    kept.every((entry, index) => comparable(entry) === comparable(expected[index]!)) &&
    (added === undefined || (fresh !== undefined && sameEntry(fresh, added, cwd)))
  if (!holds) throw new CliError(READ_BACK_FAILED)
}

/** The source with the entry appended last, or a `CliError` naming why not. Pure; `cwd` is the app root. */
export function appendNavigationEntry(source: string, input: NavigationEntryInput, cwd: string): string {
  checkInput(input)
  const ast = parse(source, resolve(cwd, NAVIGATION_FILE))
  const entries = readEntries(ast, cwd)
  if (entries.some((entry) => entry.route === input.route)) throw new CliError(`${NAVIGATION_FILE} already has an entry for route "${input.route}".`)
  const importModel = input.can !== undefined && needsModelImport(ast, input.can.model, cwd)
  return edit(() => {
    let next = insertEntry(source, ast, renderEntry(input))
    if (importModel) next = addModelImport(next, parse(next, resolve(cwd, NAVIGATION_FILE)), input.can!.model)
    readBack(next, cwd, entries, input)
    return next
  })
}

/** The source without the entry for `route`, and without the `can` model's import once nothing else names it. */
export function removeNavigationEntry(source: string, route: string, cwd: string): string {
  const ast = parse(source, resolve(cwd, NAVIGATION_FILE))
  const entries = readEntries(ast, cwd)
  const removed = entries.find((entry) => entry.route === route)
  if (removed === undefined) throw new CliError(`${NAVIGATION_FILE} has no entry for route "${route}".`)
  return edit(() => {
    let next = cutEntry(source, ast, route, entries)
    // `Job`, or the namespace `Models` of `Models.Job`.
    const local = removed.can?.model.expression.split('.')[0]
    if (local !== undefined) next = removeUnusedImport(next, local, cwd)
    readBack(next, cwd, entries.filter((entry) => entry !== removed))
    return next
  })
}

async function readNavigationSource(cwd: string): Promise<string> {
  const file = resolve(cwd, NAVIGATION_FILE)
  if (!existsSync(file)) throw new CliError(`${NAVIGATION_FILE} does not exist. \`guren add auth\` writes one with the layout that renders it.`)
  return readFile(file, 'utf8')
}

function checkModelFile(cwd: string, model: string): void {
  const file = resolve(cwd, 'app/Models', `${model}.ts`)
  if (!existsSync(file)) throw new CliError(`app/Models/${model}.ts does not exist, and the application imports ${NAVIGATION_FILE} at start: write the model first.`)
}

/**
 * Refuses a model file whose export of the name is known to be no runtime class, or absent;
 * returns why it could not be confirmed. Confirmed only by a class declared in the file and
 * exported under the name; anything else that could still be one is unconfirmed.
 */
async function checkModelExport(cwd: string, model: string): Promise<string | undefined> {
  const file = resolve(cwd, 'app/Models', `${model}.ts`)
  const ast = parseSourceFile(await readFile(file, 'utf8'), file)
  const unverified = (why: string): string => `app/Models/${model}.ts was not confirmed to export the class ${model}: ${why}.`
  if (ast === null) return unverified('it does not parse')
  const verdict = modelExportVerdict(ast, model)
  if (verdict === 'class') return undefined
  if (verdict === 'absent') throw new CliError(`app/Models/${model}.ts exports no ${model}.`)
  if (verdict === 'not-a-class') throw new CliError(`app/Models/${model}.ts exports ${model} as no runtime class (a type, a declaration or a value), so the gate has no model to ask.`)
  return unverified(verdict)
}

type ModelExportVerdict = 'class' | 'absent' | 'not-a-class' | string

const LITERALS = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral', 'TemplateLiteral', 'ObjectExpression', 'ArrayExpression', 'ArrowFunctionExpression', 'FunctionExpression'])

/** What the file binds `local` to at its top level, as far as a runtime class goes. */
function localBinding(ast: File, local: string): 'class' | 'not-a-class' | 'unknown' | undefined {
  for (const statement of ast.program.body) {
    const node = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement
    if (!node) continue
    if (node.type === 'ClassDeclaration' && node.id?.name === local) return node.declare ? 'not-a-class' : 'class'
    if ((node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration' || node.type === 'TSEnumDeclaration' || node.type === 'FunctionDeclaration') && 'id' in node && node.id?.name === local) return 'not-a-class'
    if (node.type === 'VariableDeclaration') {
      for (const declarator of node.declarations) {
        if (declarator.id.type !== 'Identifier' || declarator.id.name !== local) continue
        if (node.declare) return 'not-a-class'
        const init = declarator.init
        if (init?.type === 'ClassExpression') return 'class'
        return init && LITERALS.has(init.type) ? 'not-a-class' : 'unknown'
      }
    }
  }
  return undefined
}

function modelExportVerdict(ast: File, model: string): ModelExportVerdict {
  let open: string | undefined
  for (const statement of ast.program.body) {
    if (statement.type === 'ExportAllDeclaration') open ??= 'it re-exports another module with export *'
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = statement.declaration
    if (declaration) {
      const names = declaration.type === 'VariableDeclaration'
        ? declaration.declarations.flatMap((declarator) => (declarator.id.type === 'Identifier' ? [declarator.id.name] : []))
        : 'id' in declaration && declaration.id?.type === 'Identifier' ? [declaration.id.name] : []
      if (!names.includes(model)) continue
      if (statement.exportKind === 'type') return 'not-a-class'
      const binding = localBinding(ast, model)
      return binding === 'unknown' ? 'its value is not a class written in the file' : binding ?? 'not-a-class'
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ExportSpecifier') continue
      const exported = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value
      if (exported !== model) continue
      if (statement.exportKind === 'type' || specifier.exportKind === 'type') return 'not-a-class'
      if (statement.source) return `it re-exports ${model} from ${statement.source.value}`
      const binding = localBinding(ast, specifier.local.name)
      if (binding === 'unknown') return 'its value is not a class written in the file'
      if (binding === undefined) return `it exports ${specifier.local.name}, which the file does not declare`
      return binding
    }
  }
  return open ?? 'absent'
}

/** Git-ignored through the `.gitignore` written beside the lock. */
const LOCK_DIR = '.guren/locks'
const LOCK_WAIT_MS = 5000

/** One read, edit and atomic write, under a lock, so two writers never both succeed on the same starting file. */
async function editNavigationFile(cwd: string, edit: (source: string) => string, options: { lockWaitMs?: number }): Promise<void> {
  const lock = `${LOCK_DIR}/navigation.lock`
  await withFileLock(resolve(cwd, LOCK_DIR), 'navigation.lock', options.lockWaitMs ?? LOCK_WAIT_MS, async () => {
    const source = await readNavigationSource(cwd)
    await writeFileAtomic(resolve(cwd, NAVIGATION_FILE), edit(source))
  }, (who) => new CliError(`${NAVIGATION_FILE} is being written by ${who} (${lock}). Try again once it has finished; if nothing is writing it, delete ${lock}.`))
}

/** `guren nav:add`: the edit written in place, with the file relative to `cwd` and why the model's export went unconfirmed. */
export async function addNavigationEntryFile(cwd: string, input: NavigationEntryInput, options: { lockWaitMs?: number } = {}): Promise<{ file: string; unverified?: string }> {
  await readNavigationSource(cwd)
  let unverified: string | undefined
  if (input.can) {
    checkInput(input)
    checkModelFile(cwd, input.can.model)
    unverified = await checkModelExport(cwd, input.can.model)
  }
  await editNavigationFile(cwd, (source) => appendNavigationEntry(source, input, cwd), options)
  return { file: NAVIGATION_FILE, ...(unverified === undefined ? {} : { unverified }) }
}

/** `guren nav:remove`. */
export async function removeNavigationEntryFile(cwd: string, route: string, options: { lockWaitMs?: number } = {}): Promise<string> {
  await readNavigationSource(cwd)
  await editNavigationFile(cwd, (source) => removeNavigationEntry(source, route, cwd), options)
  return NAVIGATION_FILE
}
