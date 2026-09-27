/**
 * A browser page written in TypeScript and shipped as one HTML file: its entry bundled into a
 * classic script and written into the template at a placeholder. The plan page and the docs
 * viewer both come through here, so a build and a run from source cannot bundle them two ways.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Identifiers are left alone and nothing is minified: the page is read by whoever opens its
 * source, and neither page is large.
 */
export function bundlePageScript(pageDir: string, entry: string, what: string): string {
  if (typeof Bun === 'undefined') throw new Error(`The ${what} is bundled with Bun; run this from a Bun process.`)
  // Spawned rather than `Bun.build()`, which is async: `renderPlanHtml()` is synchronous and reaches this from source.
  const built = Bun.spawnSync([process.execPath, 'build', entry, '--format=iife', '--target=browser'], {
    // The bundler names each module in a comment, relative to here: any other directory would write the caller's into the page.
    cwd: pageDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (built.exitCode !== 0) throw new Error(`Could not bundle the ${what}:\n${built.stderr.toString()}`)
  return built.stdout.toString()
}

/** A replacement function, never a string: the bundle spells `$&` and "$`" wherever a regex or template does. */
export function composePageTemplate(html: string, script: string, placeholder: string, what: string): string {
  // Inside `<script>`, these two are the only sequences the HTML parser reads as markup.
  if (/<\/script|<!--/i.test(script)) throw new Error(`The ${what} bundle spells a sequence that would end its script block.`)
  const sites = html.split(placeholder).length - 1
  if (sites !== 1) throw new Error(`The ${what} template names its script ${sites} times; it must name it once.`)
  return html.replace(placeholder, () => script.trimEnd())
}

/** The template under `pageDir` with its entry bundled in. A missing template surfaces as the read's own `ENOENT`. */
export function composePage(pageDir: string, page: { template: string; entry: string; placeholder: string; what: string }): string {
  const html = readFileSync(join(pageDir, page.template), 'utf8')
  return composePageTemplate(html, bundlePageScript(pageDir, page.entry, page.what), page.placeholder, page.what)
}
