import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { consola } from 'consola'
import { readIfExists } from './discovery'
import { loadScaffoldTemplate, scaffoldTemplatePath } from './scaffold-templates'

export const TOKENS_PATH = 'resources/css/guren.css'
const SHIPPED_SHEET = 'guren-ui/resources/css/guren.css'
const APP_CSS_PATH = 'resources/css/app.css'
const IMPORT_LINE = "@import './guren.css';"

/* The Guren UI class vocabulary shared by every generator that emits styled
   pages. One definition, or make:auth and make:feature drift apart. */
export const FORM_INPUT_CLASS =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'
export const FIELD_LABEL_CLASS = 'block text-sm font-bold text-g-heading'
export const PRIMARY_BUTTON_CLASS =
  'rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down'
export const PRIMARY_SUBMIT_CLASS = `w-full ${PRIMARY_BUTTON_CLASS} disabled:cursor-not-allowed disabled:opacity-45`

/** Same-length blanking of block comments, so indices found on the masked text
    address the original. A commented-out import is neither an active one nor a
    place to insert after. */
function maskCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
}

const GUREN_IMPORT_RE = /@import\s+(?:url\(\s*)?['"](?:\.\/)?guren\.css['"]/

/**
 * Make sure the app carries the Guren UI design tokens the scaffolded pages
 * style with: write `resources/css/guren.css` when the app has none, and add
 * its `@import` to `resources/css/app.css`. Both halves are idempotent, and an
 * existing guren.css is never overwritten here: `guren upgrade` updates its marked block.
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
const TOKENS_OPEN = /^\/\*\s*guren:tokens\s+begin\b.*\*\/$/u
const TOKENS_CLOSE = /^\/\*\s*guren:tokens\s+end\s*\*\/$/u

/**
 * sha256 of every guren.css a release wrote before the sheet carried markers, read with LF line
 * ends. A file matching one is unedited, so `guren upgrade` may replace it whole. Closed: every
 * sheet shipped since carries the markers.
 */
export const SHIPPED_UNMARKED_SHEETS: ReadonlySet<string> = new Set([
  '71244a4c5f87c5e8a4c80248786ddd5afda7dfe9dc4e7bf8ed02749995561923',
  '3b4a633fd3c5635804112cb3d4d12adfa0586df73f2a5900248cd43a8c3bc57c',
])

interface TokenSheet {
  lines: string[]
  eol: '\n' | '\r\n'
  /** Lines of the open and close markers, absent when the sheet has none. */
  block?: { open: number; close: number }
  problems: string[]
}

/** Whether each line starts inside a block comment, so a marker commented out is no marker. */
function linesInComment(lines: readonly string[]): boolean[] {
  let inComment = false
  let quote: string | undefined
  return lines.map((line) => {
    const startsInComment = inComment
    for (let index = 0; index < line.length; index++) {
      const pair = line.slice(index, index + 2)
      if (inComment) {
        if (pair === '*/') {
          inComment = false
          index++
        }
      } else if (quote) {
        if (line[index] === '\\') index++
        else if (line[index] === quote) quote = undefined
      } else if (pair === '/*') {
        inComment = true
        index++
      } else if (line[index] === '"' || line[index] === "'") {
        quote = line[index]
      }
    }
    // A CSS string cannot span lines without an escape, so an unterminated one ends here.
    quote = undefined
    return startsInComment
  })
}

/**
 * The sheet's lines and its `guren:tokens` block, or what makes the markers unsafe to rewrite:
 * an open marker with no close, a close with no open, a second block. The rules and wording of
 * `readMarkedLines()` in `marker-blocks.ts`, which reads markdown's markers.
 */
export function readTokenSheet(css: string): TokenSheet {
  const eol = css.includes('\r\n') ? '\r\n' : '\n'
  const lines = css.split(/\r?\n/u)
  const inComment = linesInComment(lines)
  const problems: string[] = []
  let block: TokenSheet['block']
  let open: number | undefined
  const unclosed = (): void => {
    if (open !== undefined) problems.push(`line ${open + 1}: the block "${TOKENS_BLOCK}" opens and never closes`)
    open = undefined
  }
  lines.forEach((line, index) => {
    if (inComment[index]) return
    const text = line.trim()
    if (TOKENS_OPEN.test(text)) {
      unclosed()
      open = index
    } else if (TOKENS_CLOSE.test(text)) {
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
  })
  unclosed()
  return { lines, eol, ...(block ? { block } : {}), problems }
}

export type TokenSheetPlan =
  | { kind: 'current' }
  /** Marked, with a block other than the shipped one: `next` replaces the block alone. */
  | { kind: 'update'; next: string }
  /** Unmarked, and byte-identical to a sheet an earlier release wrote. */
  | { kind: 'adopt'; next: string }
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
  const shippedBlock = source.lines.slice(source.block.open, source.block.close + 1)

  if (!sheet.block) {
    const digest = createHash('sha256').update(current.replace(/\r\n/gu, '\n')).digest('hex')
    if (!SHIPPED_UNMARKED_SHEETS.has(digest)) return { kind: 'unmarked' }
    return { kind: 'adopt', next: source.lines.join(sheet.eol) }
  }

  const { open, close } = sheet.block
  const block = sheet.lines.slice(open, close + 1)
  if (block.length === shippedBlock.length && block.every((line, index) => line === shippedBlock[index])) {
    return { kind: 'current' }
  }
  const next = [...sheet.lines.slice(0, open), ...shippedBlock, ...sheet.lines.slice(close + 1)]
  return { kind: 'update', next: next.join(sheet.eol) }
}

export interface TokenSheetVerdict {
  status: 'pass' | 'warn'
  message: string
  fix?: string
  manualFix?: string
  canAutofix?: boolean
}

/** The sheet the running CLI ships, from the app root when it is installed there. */
function shippedSheetLocation(cwd: string): string {
  const path = scaffoldTemplatePath(SHIPPED_SHEET)
  const fromApp = relative(cwd, path)
  return fromApp.startsWith('..') || isAbsolute(fromApp) ? path : fromApp
}

/** `guren doctor`'s reading of the app's token sheet; `guren upgrade` applies the fix it offers. */
export async function judgeTokenSheet(cwd: string): Promise<TokenSheetVerdict> {
  const current = await readIfExists(cwd, TOKENS_PATH)
  if (current === null) return { status: 'pass', message: `No ${TOKENS_PATH}; the app does not use the Guren UI tokens.` }

  const plan = planTokenSheet(current, loadScaffoldTemplate(SHIPPED_SHEET))
  switch (plan.kind) {
    case 'current':
      return { status: 'pass', message: `${TOKENS_PATH} carries the Guren UI tokens this CLI ships.` }
    case 'update':
      return {
        status: 'warn',
        message: `The ${TOKENS_BLOCK} block in ${TOKENS_PATH} differs from the one this CLI ships.`,
        fix: `Run \`guren upgrade\` to replace the block between the ${TOKENS_BLOCK} markers; text outside them is kept.`,
        canAutofix: true,
      }
    case 'adopt':
      return {
        status: 'warn',
        message: `${TOKENS_PATH} is an unedited sheet from an earlier release, with no ${TOKENS_BLOCK} markers to update it by.`,
        fix: `Run \`guren upgrade\` to replace it with the current sheet, whose ${TOKENS_BLOCK} block later upgrades keep current.`,
        canAutofix: true,
      }
    case 'unmarked': {
      const steps =
        `Copy your own rules out of ${TOKENS_PATH}, replace the file with ${shippedSheetLocation(cwd)}, `
        + 'and add your rules back after its `/* guren:tokens end */` line.'
      return {
        status: 'warn',
        message: `${TOKENS_PATH} has no ${TOKENS_BLOCK} markers and differs from every shipped sheet, so upgrades cannot update its tokens.`,
        fix: steps,
        manualFix: steps,
      }
    }
    case 'unsafe': {
      const steps = `Leave one \`/* guren:tokens begin … */\` line and one \`/* guren:tokens end */\` line after it in ${TOKENS_PATH}.`
      return {
        status: 'warn',
        message: `The ${TOKENS_BLOCK} markers in ${TOKENS_PATH} cannot be rewritten safely: ${plan.problems.join('; ')}.`,
        fix: steps,
        manualFix: steps,
      }
    }
  }
}

/** Rewrite the app's token sheet when {@link planTokenSheet} allows it; reports whether it wrote. */
export async function updateTokenSheet(cwd: string): Promise<boolean> {
  const current = await readIfExists(cwd, TOKENS_PATH)
  if (current === null) return false
  const plan = planTokenSheet(current, loadScaffoldTemplate(SHIPPED_SHEET))
  if (plan.kind !== 'update' && plan.kind !== 'adopt') return false
  await writeFile(resolve(cwd, TOKENS_PATH), plan.next, 'utf8')
  return true
}
