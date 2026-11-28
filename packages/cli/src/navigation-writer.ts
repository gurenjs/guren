/**
 * The one writer of `config/navigation.ts` (RFC 0040 §5): `appendNavigationEntry()` and its
 * counterpart, edits to the source text that `readNavigationFile()` must read back as exactly the
 * entries before plus or minus one, else nothing is written. `guren nav:add` and `nav:remove`
 * call them; `make:feature` and a plan's `commands` are to go through them too.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { File, ImportDeclaration, Node } from '@babel/types'

import { referencedIdentifiers } from './ast-walk'
import { CliError } from './cli-error'
import { navigationEntryList, readNavigationFile, type NavigationFileAuth, type NavigationFileEntry } from './navigation-file'
import { parseSourceFile } from './parse-cache'
import { exportedNames } from './plan/app-detail'
import { writeFileAtomic } from './plan/beside'

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
  if (last === undefined) {
    const indent = indentAt(source, start)
    return `${source.slice(0, start)}[\n${indent}  ${entry},\n${indent}]${source.slice(end)}`
  }
  const lastEnd = span(last).end
  const sameLine = !source.slice(start, span(last).start).includes('\n')
  const comma = commaAfter(source, lastEnd, end - 1)
  if (sameLine) {
    return comma === undefined
      ? `${source.slice(0, lastEnd)}, ${entry}${source.slice(lastEnd)}`
      : `${source.slice(0, comma)} ${entry},${source.slice(comma)}`
  }
  const indent = indentAt(source, span(last).start)
  // A comment closing the last entry's line stays on that line.
  const after = comma ?? lastEnd
  const lineEnd = source.indexOf('\n', after)
  const rest = source.slice(after, lineEnd === -1 ? end - 1 : lineEnd)
  const at = lineEnd !== -1 && lineEnd < end && /^\s*(?:\/\/.*)?$/u.test(rest) ? lineEnd : after
  const head = comma === undefined ? `${source.slice(0, lastEnd)},${source.slice(lastEnd, at)}` : source.slice(0, at)
  return `${head}\n${indent}${entry}${comma === undefined ? '' : ','}${source.slice(at)}`
}

/** The text with one range cut, widened to whole lines when nothing else shares them. */
function cut(source: string, from: number, to: number): string {
  const start = lineStart(source, from)
  const lineEnd = source.indexOf('\n', to)
  const end = lineEnd === -1 ? source.length : lineEnd + 1
  // A comment closing the line goes with what it closed.
  if (source.slice(start, from).trim() === '' && /^[ \t]*(?:\/\/[^\n]*)?\n?$/u.test(source.slice(to, end))) return source.slice(0, start) + source.slice(end)
  return source.slice(0, from) + source.slice(to).replace(/^[ \t]*/u, '')
}

function cutEntry(source: string, ast: File, route: string, entries: NavigationFileEntry[]): string {
  const list = navigationEntryList(ast)!
  const elements = list.elements as Node[]
  const index = entries.findIndex((entry) => entry.route === route)
  const element = elements[index]!
  const { start, end } = span(element)
  const comma = commaAfter(source, end, span(list).end - 1)
  if (elements.length === 1) {
    const inside = source.slice(span(list).start + 1, start) + source.slice(comma ?? end, span(list).end - 1)
    if (inside.trim() === '') return `${source.slice(0, span(list).start)}[]${source.slice(span(list).end)}`
  }
  if (comma !== undefined) return cut(source, start, comma)
  const previous = elements[index - 1]
  if (previous === undefined) return cut(source, start, end)
  // The last entry and no trailing comma: the comma before it goes with it.
  const previousComma = commaAfter(source, span(previous).end, start)
  if (previousComma === undefined) return cut(source, start, end)
  if (!source.slice(span(previous).end, start).includes('\n')) return source.slice(0, span(previous).end) + source.slice(end)
  const joined = cut(source, start, end)
  return joined.slice(0, span(previous).end) + joined.slice(previousComma)
}

const importsOf = (ast: File): ImportDeclaration[] =>
  ast.program.body.filter((statement): statement is ImportDeclaration => statement.type === 'ImportDeclaration')

/** Whether the file before the edit needs the model's import, refusing a name it already binds to something else. */
function needsModelImport(ast: File, model: string): boolean {
  for (const declaration of importsOf(ast)) {
    for (const specifier of declaration.specifiers) {
      if (specifier.local.name !== model) continue
      const isModel = declaration.source.value === modelSpecifier(model) && specifier.type === 'ImportSpecifier' && declaration.importKind !== 'type'
      if (isModel) return false
      throw new CliError(`${NAVIGATION_FILE} already imports a ${model} from ${declaration.source.value}, which is not ${modelSpecifier(model)}.`)
    }
  }
  if (referencedIdentifiers(ast.program).includes(model)) throw new CliError(`${NAVIGATION_FILE} already names a ${model} that is not the model.`)
  return true
}

function addModelImport(source: string, ast: File, model: string): string {
  const line = `import { ${model} } from '${modelSpecifier(model)}'\n`
  const lastImport = importsOf(ast).at(-1)
  if (lastImport === undefined) return line + source
  const after = source.indexOf('\n', span(lastImport).end)
  const at = after === -1 ? source.length : after + 1
  return `${source.slice(0, at)}${after === -1 ? '\n' : ''}${line}${source.slice(at)}`
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
  const specifiers = declaration.specifiers
  const index = specifiers.findIndex((specifier) => specifier.local.name === model)
  const specifier = specifiers[index]!
  const next = specifiers[index + 1]
  if (next !== undefined) return source.slice(0, span(specifier).start) + source.slice(span(next).start)
  return source.slice(0, span(specifiers[index - 1]!).end) + source.slice(span(specifier).end)
}

const sameEntry = (entry: NavigationFileEntry, input: NavigationEntryInput): boolean =>
  entry.label === input.label &&
  entry.route === input.route &&
  entry.auth === input.auth &&
  entry.where === undefined &&
  entry.can?.ability === input.can?.ability &&
  entry.can?.model.className === input.can?.model

const comparable = (entry: NavigationFileEntry): string => JSON.stringify({ ...entry, line: undefined })

function readBack(source: string, cwd: string, expected: NavigationFileEntry[], added?: NavigationEntryInput): void {
  const entries = readEntries(parse(source, resolve(cwd, NAVIGATION_FILE)), cwd)
  const kept = added === undefined ? entries : entries.slice(0, -1)
  const fresh = added === undefined ? undefined : entries.at(-1)
  const holds =
    kept.length === expected.length &&
    kept.every((entry, index) => comparable(entry) === comparable(expected[index]!)) &&
    (added === undefined || (fresh !== undefined && sameEntry(fresh, added)))
  if (!holds) throw new CliError(`The edit to ${NAVIGATION_FILE} would not read back as intended, so nothing was written. Edit the file by hand.`)
}

/** The source with the entry appended last, or a `CliError` naming why not. Pure; `cwd` is the app root. */
export function appendNavigationEntry(source: string, input: NavigationEntryInput, cwd: string): string {
  checkInput(input)
  const ast = parse(source, resolve(cwd, NAVIGATION_FILE))
  const entries = readEntries(ast, cwd)
  if (entries.some((entry) => entry.route === input.route)) throw new CliError(`${NAVIGATION_FILE} already has an entry for route "${input.route}".`)
  const importModel = input.can !== undefined && needsModelImport(ast, input.can.model)
  let next = insertEntry(source, ast, renderEntry(input))
  if (importModel) next = addModelImport(next, parse(next, resolve(cwd, NAVIGATION_FILE)), input.can!.model)
  readBack(next, cwd, entries, input)
  return next
}

/** The source without the entry for `route`, and without the `can` model's import once nothing else names it. */
export function removeNavigationEntry(source: string, route: string, cwd: string): string {
  const ast = parse(source, resolve(cwd, NAVIGATION_FILE))
  const entries = readEntries(ast, cwd)
  const removed = entries.find((entry) => entry.route === route)
  if (removed === undefined) throw new CliError(`${NAVIGATION_FILE} has no entry for route "${route}".`)
  let next = cutEntry(source, ast, route, entries)
  const model = removed.can?.model
  if (model !== undefined && !model.expression.includes('.')) next = removeUnusedImport(next, model.expression, cwd)
  readBack(next, cwd, entries.filter((entry) => entry !== removed))
  return next
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

async function checkModelExport(cwd: string, model: string): Promise<void> {
  const file = resolve(cwd, 'app/Models', `${model}.ts`)
  const ast = parseSourceFile(await readFile(file, 'utf8'), file)
  if (ast === null) return
  const classes = ast.program.body.flatMap((node) =>
    node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration' && node.declaration.id ? [node.declaration.id.name] : [])
  const names = exportedNames(ast, 'anywhere')
  if (names !== null && ![...names, ...classes].includes(model)) throw new CliError(`app/Models/${model}.ts exports no ${model}.`)
}

/** `guren nav:add`: the edit written in place; returns the file's path relative to `cwd`. */
export async function addNavigationEntryFile(cwd: string, input: NavigationEntryInput): Promise<string> {
  const source = await readNavigationSource(cwd)
  if (input.can) {
    checkInput(input)
    checkModelFile(cwd, input.can.model)
    await checkModelExport(cwd, input.can.model)
  }
  await writeFileAtomic(resolve(cwd, NAVIGATION_FILE), appendNavigationEntry(source, input, cwd))
  return NAVIGATION_FILE
}

/** `guren nav:remove`. */
export async function removeNavigationEntryFile(cwd: string, route: string): Promise<string> {
  const source = await readNavigationSource(cwd)
  await writeFileAtomic(resolve(cwd, NAVIGATION_FILE), removeNavigationEntry(source, route, cwd))
  return NAVIGATION_FILE
}
