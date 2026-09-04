import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { consola } from 'consola'
import { readIfExists } from './discovery'
import { loadScaffoldTemplate } from './scaffold-templates'

const TOKENS_PATH = 'resources/css/guren.css'
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
 * existing guren.css is never overwritten — it may carry the user's own edits.
 */
export async function ensureGurenUiTokens(cwd: string = process.cwd()): Promise<void> {
  const tokensPath = resolve(cwd, TOKENS_PATH)
  await mkdir(dirname(tokensPath), { recursive: true })
  try {
    // `wx` makes the exists-check and the write atomic, as in writeFileSafe —
    // but here an existing file is expected, not an error.
    await writeFile(tokensPath, loadScaffoldTemplate('guren-ui/resources/css/guren.css'), {
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
