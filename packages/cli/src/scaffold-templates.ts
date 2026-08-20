import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Static scaffold templates, shipped as real source files under
 * `templates/scaffold/` instead of template literals in the generator
 * modules. The tree mirrors the generated app: a template's path relative to
 * `templates/scaffold/<scaffold>/` is exactly the path the generator writes
 * it to, so relative imports between templates resolve in place and
 * `tsconfig.templates.json` can typecheck the whole tree as one app-shaped
 * project.
 *
 * Only fully static files live here. Anything whose contents vary by flags or
 * fields stays a builder function next to its generator — a template engine
 * would buy file extraction at the cost of the templates no longer being
 * valid TypeScript, which is the property this layout exists for.
 */
const scaffoldTemplateDir = fileURLToPath(new URL('../templates/scaffold', import.meta.url))

/** Read one shipped template, `relativePath` in POSIX form (`auth/config/mail.ts`). */
export function loadScaffoldTemplate(relativePath: string): string {
  return readFileSync(join(scaffoldTemplateDir, ...relativePath.split('/')), 'utf8')
}
