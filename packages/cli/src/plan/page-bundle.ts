/**
 * The plan page's script (`page/main.ts`) as one classic script, and the template it
 * is written into. `scripts/build-plan-page.ts` and the from-source path of `assets.ts`
 * both come through here, so a build and a test run cannot bundle it two ways.
 */

import { composePage, composePageTemplate } from '../page-bundle'

export const PLAN_SCRIPT_PLACEHOLDER = '__GUREN_PLAN_SCRIPT__'

/** Where the composed page is written and read back, relative to the package root; `files` ships it. */
export const PLAN_ASSET_DIR = 'assets/plan'
export const PLAN_TEMPLATE_FILE = 'index.html'
const PLAN_PAGE_ENTRY = 'main.ts'
const WHAT = 'plan page'

export function composePlanTemplate(html: string, script: string): string {
  return composePageTemplate(html, script, PLAN_SCRIPT_PLACEHOLDER, WHAT)
}

/** The template under `pageDir` with its entry bundled in. A missing template surfaces as the read's own `ENOENT`. */
export function composePlanPage(pageDir: string): string {
  return composePage(pageDir, { template: PLAN_TEMPLATE_FILE, entry: PLAN_PAGE_ENTRY, placeholder: PLAN_SCRIPT_PLACEHOLDER, what: WHAT })
}
