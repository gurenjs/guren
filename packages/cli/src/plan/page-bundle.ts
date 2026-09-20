/**
 * The plan page's script (`page/main.ts`) as one classic script, and the template it
 * is written into. `scripts/build-plan-page.ts` and the from-source path of `assets.ts`
 * both come through here, so a build and a test run cannot bundle it two ways.
 */

import { basename, dirname } from 'node:path'

export const PLAN_SCRIPT_PLACEHOLDER = '__GUREN_PLAN_SCRIPT__'

/**
 * Identifiers are left alone and nothing is minified: the page is read by whoever
 * opens its source, and a rendered plan is small either way.
 */
export function bundlePlanPage(entry: string): string {
  if (typeof Bun === 'undefined') throw new Error('The plan page is bundled with Bun; run this from a Bun process.')
  const built = Bun.spawnSync([process.execPath, 'build', basename(entry), '--format=iife', '--target=browser'], {
    // The bundler names each module in a comment, relative to here: any other directory would write the caller's into the page.
    cwd: dirname(entry),
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
