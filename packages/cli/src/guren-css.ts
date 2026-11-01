import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { consola } from 'consola'
import { readIfExists } from './discovery'
import { writeFileAtomic } from './plan/beside'
import { loadScaffoldTemplate, scaffoldTemplatePath } from './scaffold-templates'
import { writeScaffoldFiles, type ScaffoldFileEntry } from './utils'

export const TOKENS_PATH = 'resources/css/guren.css'
const SHIPPED_SHEET = 'guren-ui/resources/css/guren.css'
const APP_CSS_PATH = 'resources/css/app.css'
const IMPORT_LINE = "@import './guren.css';"

/** Same-length blanking of block comments, so indices found on the masked text
    address the original. A commented-out import is neither an active one nor a
    place to insert after. */
function maskCssComments(css: string): string {
  return css.replace(CSS_COMMENT, (match) => ' '.repeat(match.length))
}

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g

const GUREN_IMPORT_RE = /@import\s+(?:url\(\s*)?['"](?:\.\/)?guren\.css['"]/

/**
 * Make sure the app carries the Guren UI design tokens the scaffolded pages
 * style with: write `resources/css/guren.css` when the app has none, and add
 * its `@import` to `resources/css/app.css`. Both halves are idempotent, and an
 * existing guren.css is never overwritten here: `guren upgrade` updates its marked block.
 * `writeScaffoldFiles` calls it for a batch that writes a styled page.
 */
export async function ensureGurenUiTokens(cwd: string = process.cwd()): Promise<void> {
  const tokensPath = resolve(cwd, TOKENS_PATH)
  await mkdir(dirname(tokensPath), { recursive: true })
  try {
    // `wx` makes the exists-check and the write atomic, as in writeFileSafe —
    // but here an existing file is expected, not an error.
    await writeFile(tokensPath, loadScaffoldTemplate(SHIPPED_SHEET), {
      encoding: 'utf8',
      flag: 'wx',
    })
    consola.success(`Created ${TOKENS_PATH}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const appCss = await readIfExists(cwd, APP_CSS_PATH)
  if (appCss === null) {
    consola.warn(
      `${APP_CSS_PATH} not found — add ${IMPORT_LINE} to your CSS entry so the Guren UI tokens load.`,
    )
    return
  }

  const masked = maskCssComments(appCss)
  if (GUREN_IMPORT_RE.test(masked)) return

  // After the last complete @import: CSS requires @import to precede other
  // rules, and the @theme mapping must land after the tailwindcss import.
  // Matching whole statements, not lines, keeps a multiline one intact.
  const imports = [...masked.matchAll(/@import[^;]*;/g)]
  const last = imports.at(-1)
  const updated = last
    ? appCss.slice(0, last.index + last[0].length)
      + `\n${IMPORT_LINE}`
      + appCss.slice(last.index + last[0].length)
    : `${IMPORT_LINE}\n${appCss}`
  await writeFile(resolve(cwd, APP_CSS_PATH), updated, 'utf8')
  consola.success(`Added ${IMPORT_LINE} to ${APP_CSS_PATH}`)
}

const TOKENS_BLOCK = 'guren:tokens'
const TOKENS_OPEN = /^\/\*\s*guren:tokens\s+begin\b/u
const TOKENS_CLOSE = /^\/\*\s*guren:tokens\s+end\s*\*\/$/u

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * sha256 of every guren.css a release wrote before the sheet carried markers, read with LF line
 * ends. A file matching one is unedited, so `guren upgrade` may replace it whole. Closed: every
 * sheet shipped since carries the markers.
 */
export const SHIPPED_UNMARKED_SHEETS: ReadonlySet<string> = new Set([
  '71244a4c5f87c5e8a4c80248786ddd5afda7dfe9dc4e7bf8ed02749995561923',
  '3b4a633fd3c5635804112cb3d4d12adfa0586df73f2a5900248cd43a8c3bc57c',
])

/**
 * sha256 of every `guren:tokens` block a release shipped, markers included, lines joined by LF.
 * Only a block listed here is replaced: any other was edited, or written by a newer Guren than the
 * running CLI. Append the hash of each new block; `tests/guren-css-upgrade.test.ts` fails until the
 * shipped block is listed.
 */
export const SHIPPED_TOKEN_BLOCKS: ReadonlySet<string> = new Set([
  '2b56a75e643f0c15db89d922115042a78ca7ebc7d415160e12fcd54f154d0f57',
])

interface TokenSheet {
  lines: string[]
  eol: '\n' | '\r\n'
  /** Lines of the open and close markers, absent when the sheet has none. */
  block?: { open: number; close: number }
  problems: string[]
}

/**
 * Each line that holds one comment and nothing else, by the comment rule {@link maskCssComments}
 * uses, so a marker inside a longer comment or beside a rule is no marker.
 */
function commentLines(css: string, lines: readonly string[]): Map<number, string> {
  const found = new Map<number, string>()
  let line = 0
  let scanned = 0
  for (const match of css.matchAll(CSS_COMMENT)) {
    for (; scanned < match.index; scanned++) if (css[scanned] === '\n') line++
    if (lines[line]?.trim() === match[0]) found.set(line, match[0])
  }
  return found
}

/**
 * The sheet's lines and its `guren:tokens` block, or what makes the markers unsafe to rewrite:
 * an open marker with no close, a close with no open, a second block. The rules and wording of
 * `readMarkedLines()` in `marker-blocks.ts`, which reads markdown's markers.
 */
export function readTokenSheet(css: string): TokenSheet {
  const eol = css.includes('\r\n') ? '\r\n' : '\n'
  const lines = css.split(/\r?\n/u)
  const problems: string[] = []
  let block: TokenSheet['block']
  let open: number | undefined
  const unclosed = (): void => {
    if (open !== undefined) problems.push(`line ${open + 1}: the block "${TOKENS_BLOCK}" opens and never closes`)
    open = undefined
  }
  for (const [index, comment] of commentLines(css, lines)) {
    if (TOKENS_OPEN.test(comment)) {
      unclosed()
      open = index
    } else if (TOKENS_CLOSE.test(comment)) {
      if (open === undefined) {
        problems.push(`line ${index + 1}: the block "${TOKENS_BLOCK}" closes and never opened`)
      } else if (block) {
        problems.push(`line ${open + 1}: the block "${TOKENS_BLOCK}" appears twice`)
        open = undefined
      } else {
        block = { open, close: index }
        open = undefined
      }
    }
  }
  unclosed()
  return { lines, eol, ...(block ? { block } : {}), problems }
}

/** The block's lines, markers included; the caller has read a block. */
function blockLines(sheet: TokenSheet): string[] {
  const { open, close } = sheet.block!
  return sheet.lines.slice(open, close + 1)
}

export type TokenSheetPlan =
  | { kind: 'current' }
  /** A block an earlier release shipped: `next` replaces the block alone. */
  | { kind: 'update'; next: string }
  /** Unmarked, and byte-identical to a sheet an earlier release wrote. */
  | { kind: 'adopt'; next: string }
  /** A block no release shipped: edited, or newer than this CLI. */
  | { kind: 'edited' }
  /** Unmarked and edited: nothing tells the tokens from the user's text. */
  | { kind: 'unmarked' }
  | { kind: 'unsafe'; problems: string[] }

/** What `guren upgrade` may do to an app's guren.css, given the sheet this CLI ships. */
export function planTokenSheet(current: string, shipped: string): TokenSheetPlan {
  const sheet = readTokenSheet(current)
  if (sheet.problems.length > 0) return { kind: 'unsafe', problems: sheet.problems }

  const source = readTokenSheet(shipped)
  if (!source.block || source.problems.length > 0) {
    throw new Error(`The shipped ${TOKENS_PATH} carries no readable ${TOKENS_BLOCK} block: ${source.problems.join('; ')}`)
  }

  if (!sheet.block) {
    if (!SHIPPED_UNMARKED_SHEETS.has(sha256(current.replace(/\r\n/gu, '\n')))) return { kind: 'unmarked' }
    return { kind: 'adopt', next: source.lines.join(sheet.eol) }
  }

  const block = blockLines(sheet).join('\n')
  const shippedBlock = blockLines(source)
  if (block === shippedBlock.join('\n')) return { kind: 'current' }
  if (!SHIPPED_TOKEN_BLOCKS.has(sha256(block))) return { kind: 'edited' }
  const { open, close } = sheet.block
  const next = [...sheet.lines.slice(0, open), ...shippedBlock, ...sheet.lines.slice(close + 1)]
  return { kind: 'update', next: next.join(sheet.eol) }
}

/** The plan for the app's own sheet, or `undefined` when it has none. Throws when it cannot be read. */
export async function planAppTokenSheet(cwd: string): Promise<TokenSheetPlan | undefined> {
  const current = await readIfExists(cwd, TOKENS_PATH)
  return current === null ? undefined : planTokenSheet(current, loadScaffoldTemplate(SHIPPED_SHEET))
}

/** The sheet the running CLI ships, from the app root when it is installed there. */
export function shippedTokenSheetLocation(cwd: string): string {
  const path = scaffoldTemplatePath(SHIPPED_SHEET)
  const fromApp = relative(cwd, path)
  return fromApp.startsWith('..') || isAbsolute(fromApp) ? path : fromApp
}

/** Rewrite the app's token sheet when {@link planTokenSheet} allows it. */
export async function updateTokenSheet(cwd: string): Promise<void> {
  const plan = await planAppTokenSheet(cwd)
  if (plan?.kind === 'update' || plan?.kind === 'adopt') await writeFileAtomic(resolve(cwd, TOKENS_PATH), plan.next)
}

export const UI_COMPONENTS_DIR = 'resources/js/components/ui'

/** The components `guren add ui` copies, one file each under {@link UI_COMPONENTS_DIR}. */
export const UI_COMPONENTS = ['Alert', 'Button', 'Card', 'Checkbox', 'Field', 'Input', 'Label', 'Select', 'Textarea'] as const
export type UiComponentName = (typeof UI_COMPONENTS)[number]

/**
 * sha256 of every template version a release shipped per component, the current one included, read
 * with LF line ends. A copy matching one is unedited, so `guren upgrade` may replace it. Append the
 * hash of each new template and bump its header's `vN`; `tests/ui-components.test.ts` fails until both agree.
 */
export const SHIPPED_UI_COMPONENTS: Readonly<Record<UiComponentName, ReadonlySet<string>>> = {
  Alert: new Set(['fcacd69a956fdc4b381a846393ec65a922e79b9351cd48bda2870d58d23ed2bb']),
  Button: new Set(['52b772daee828464bd1708e92995fe6c3f7227776aa50da49950857cc5a6f1f9']),
  Card: new Set(['0b399883734e631bbaf9de5daebd87eb345f968fca503b81a113ab1a49c9015f']),
  Checkbox: new Set(['b42805cd83473ebadca103a75fa6ca90d7b134dcb495410c7c3d92a249c88b5a']),
  Field: new Set(['83c3463479f5c483d9d3278b3829c2111b45e6b73b40d5ec4f61be99cc5cfbdc']),
  Input: new Set(['ea7215126e14061445ba343f52e010eae0eb1b634e76c601d86b6aa009b386b7']),
  Label: new Set(['f6230461533783175f577743b33e3824e0a4dad8cbc5f939bdf315e56ad5cb53']),
  Select: new Set(['e8d24f137fc1f9a197522589ba6f54de547a9f00b64de31389f59b6a35ff2dea']),
  Textarea: new Set(['d56e8e8b3e8dc5e686326a44bd877879e9de638dce56f7d829be2585158adcf0']),
}

/** The shipped components each one imports, which are copied with it so no copy imports a missing file. */
export const UI_COMPONENT_DEPENDENCIES: Readonly<Partial<Record<UiComponentName, readonly UiComponentName[]>>> = {
  Field: ['Checkbox', 'Input', 'Label', 'Select', 'Textarea'],
}

/** The names with everything they import, in {@link UI_COMPONENTS} order. */
export function withUiDependencies(names: readonly UiComponentName[]): UiComponentName[] {
  const wanted = new Set(names.flatMap((name) => [name, ...(UI_COMPONENT_DEPENDENCIES[name] ?? [])]))
  return UI_COMPONENTS.filter((name) => wanted.has(name))
}

export function uiComponentPath(name: UiComponentName): string {
  return `${UI_COMPONENTS_DIR}/${name}.tsx`
}

/** The template this CLI ships for one component. */
export function uiComponentTemplate(name: UiComponentName): string {
  return loadScaffoldTemplate(`ui/${uiComponentPath(name)}`)
}

export function uiComponentEntry(name: UiComponentName): ScaffoldFileEntry {
  return { path: uiComponentPath(name), contents: uiComponentTemplate(name) }
}

/** `undefined` when no shipped component carries that name, compared without case. */
export function findUiComponent(name: string): UiComponentName | undefined {
  return UI_COMPONENTS.find((component) => component.toLowerCase() === name.toLowerCase())
}

export const uiComponentHash = (text: string): string => sha256(text.replace(/\r\n/gu, '\n'))

const UI_HEADER = /^\/\/ guren-ui: (\w+ v\d+)\b/u

export type UiComponentPlan =
  | { kind: 'current' }
  /** Byte-identical, up to line ends, to a template an earlier release shipped. */
  | { kind: 'update'; next: string }
  /** Matches no released template; `claimed` is the version its header names, when it has one. */
  | { kind: 'edited'; claimed?: string }

/** What `guren upgrade` may do to one copied component. */
export function planUiComponent(current: string, template: string, released: ReadonlySet<string>): UiComponentPlan {
  const hash = uiComponentHash(current)
  if (hash === uiComponentHash(template)) return { kind: 'current' }
  if (released.has(hash)) return { kind: 'update', next: template }
  const claimed = UI_HEADER.exec(current)?.[1]
  return claimed ? { kind: 'edited', claimed } : { kind: 'edited' }
}

export interface AppUiComponentPlan {
  name: UiComponentName
  path: string
  plan: UiComponentPlan
}

/** The plan for each shipped component the app has a copy of. Throws when a copy cannot be read. */
export async function planAppUiComponents(cwd: string): Promise<AppUiComponentPlan[]> {
  const plans: AppUiComponentPlan[] = []
  for (const name of UI_COMPONENTS) {
    const path = uiComponentPath(name)
    const current = await readIfExists(cwd, path)
    if (current === null) continue
    plans.push({ name, path, plan: planUiComponent(current, uiComponentTemplate(name), SHIPPED_UI_COMPONENTS[name]) })
  }
  return plans
}

/** Replace every copy {@link planUiComponent} calls unedited with the current template. */
export async function updateUiComponents(cwd: string): Promise<void> {
  for (const { path, plan } of await planAppUiComponents(cwd)) {
    if (plan.kind === 'update') await writeFileAtomic(resolve(cwd, path), plan.next)
  }
}

const UI_COMPONENT_IMPORT = /from '@\/resources\/js\/components\/ui\/(\w+)'/gu

/** The shipped components the files import, in {@link UI_COMPONENTS} order. */
export function uiComponentsImportedBy(entries: readonly ScaffoldFileEntry[]): UiComponentName[] {
  const imported = new Set(entries.flatMap((entry) => [...entry.contents.matchAll(UI_COMPONENT_IMPORT)].map((match) => match[1])))
  return UI_COMPONENTS.filter((name) => imported.has(name))
}

/**
 * Write the components a generated page imports that the app lacks, so the page never imports a
 * missing file. An existing copy is never touched, whatever the generator's `force`. Announces each
 * write itself, as {@link ensureGurenUiTokens} does, and returns the absolute paths written.
 */
export async function ensureUiComponents(cwd: string, names: readonly UiComponentName[]): Promise<string[]> {
  const missing: ScaffoldFileEntry[] = []
  for (const name of withUiDependencies(names)) {
    if ((await readIfExists(cwd, uiComponentPath(name))) === null) missing.push(uiComponentEntry(name))
  }
  if (missing.length === 0) return []
  const written = await writeScaffoldFiles(missing, { cwd, skipExisting: true })
  for (const path of written) consola.success(`Created ${relative(cwd, path)}`)
  return written
}
