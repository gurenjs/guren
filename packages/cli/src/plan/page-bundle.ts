/**
 * The plan page's script (`page/main.ts`) as one classic script, and the template it
 * is written into. `scripts/build-plan-page.ts` and the from-source path of `assets.ts`
 * both come through here, so a build and a test run cannot bundle it two ways.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PLAN_SCRIPT_PLACEHOLDER = '__GUREN_PLAN_SCRIPT__'

/** Where the composed page is written and read back, relative to the package root; `files` ships it. */
export const PLAN_ASSET_DIR = 'assets/plan'
export const PLAN_TEMPLATE_FILE = 'index.html'
const PLAN_PAGE_ENTRY = 'main.ts'

/**
 * Identifiers are left alone and nothing is minified: the page is read by whoever
 * opens its source, and a rendered plan is small either way.
 */
function bundlePlanPage(pageDir: string): string {
  if (typeof Bun === 'undefined') throw new Error('The plan page is bundled with Bun; run this from a Bun process.')
  // Spawned rather than `Bun.build()`, which is async: `renderPlanHtml()` is synchronous and reaches this from source.
  const built = Bun.spawnSync([process.execPath, 'build', PLAN_PAGE_ENTRY, '--format=iife', '--target=browser'], {
    // The bundler names each module in a comment, relative to here: any other directory would write the caller's into the page.
    cwd: pageDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (built.exitCode !== 0) throw new Error(`Could not bundle the plan page:\n${built.stderr.toString()}`)
  return built.stdout.toString()
}

/** A replacement function, never a string: the bundle spells `$&` and "$`" wherever a regex or template does. */
export function composePlanTemplate(html: string, script: string): string {
  // Inside `<script>`, these two are the only sequences the HTML parser reads as markup.
  if (/<\/script|<!--/i.test(script)) throw new Error('The plan page bundle spells a sequence that would end its script block.')
  const sites = html.split(PLAN_SCRIPT_PLACEHOLDER).length - 1
  if (sites !== 1) throw new Error(`The plan template names its script ${sites} times; it must name it once.`)
  return html.replace(PLAN_SCRIPT_PLACEHOLDER, () => script.trimEnd())
}

/** The template under `pageDir` with its entry bundled in. A missing template surfaces as the read's own `ENOENT`. */
export function composePlanPage(pageDir: string): string {
  const html = readFileSync(join(pageDir, PLAN_TEMPLATE_FILE), 'utf8')
  return composePlanTemplate(html, bundlePlanPage(pageDir))
}
