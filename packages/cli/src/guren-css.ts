import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { consola } from 'consola'
import { loadScaffoldTemplate } from './scaffold-templates'

const TOKENS_PATH = 'resources/css/guren.css'
const APP_CSS_PATH = 'resources/css/app.css'
const IMPORT_LINE = "@import './guren.css';"

/**
 * Make sure the app carries the Guren UI design tokens the scaffolded pages
 * style with (`bg-g-page`, `text-g-accent-text`, …): write
 * `resources/css/guren.css` when the app has none, and add its `@import` to
 * `resources/css/app.css` when that is missing. Both halves are idempotent.
 * An existing guren.css is never overwritten — it may carry the user's own
 * edited tokens, and create-guren-app ships the same file already.
 */
export async function ensureGurenUiTokens(cwd: string = process.cwd()): Promise<void> {
  const tokensPath = resolve(cwd, TOKENS_PATH)
  await mkdir(dirname(tokensPath), { recursive: true })
  try {
    // `wx` makes the exists-check and the write one atomic operation, the
    // same reasoning as writeFileSafe — but here an existing file is the
    // fine-and-expected case, not an error.
    await writeFile(tokensPath, loadScaffoldTemplate('guren-ui/resources/css/guren.css'), {
      encoding: 'utf8',
      flag: 'wx',
    })
    consola.success(`Created ${TOKENS_PATH}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const appCssPath = resolve(cwd, APP_CSS_PATH)
  let appCss: string
  try {
    appCss = await readFile(appCssPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    consola.warn(
      `${APP_CSS_PATH} not found — add ${IMPORT_LINE} to your CSS entry so the Guren UI tokens load.`,
    )
    return
  }
  if (appCss.includes('./guren.css')) return

  // CSS requires @import to precede other rules, and Tailwind's @theme
  // mapping inside guren.css has to land after the tailwindcss import — so
  // slot it right after the last @import when there is one.
  const lines = appCss.split('\n')
  let lastImport = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimStart().startsWith('@import')) lastImport = i
  }
  if (lastImport >= 0) {
    lines.splice(lastImport + 1, 0, IMPORT_LINE)
  } else {
    lines.unshift(IMPORT_LINE)
  }
  await writeFile(appCssPath, lines.join('\n'), 'utf8')
  consola.success(`Added ${IMPORT_LINE} to ${APP_CSS_PATH}`)
}
