import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Static scaffold templates, shipped as real source files under
 * `templates/scaffold/` instead of template literals in the generator
 * modules. The tree mirrors the generated app: a template's path relative to
 * `templates/scaffold/<scaffold>/` is exactly the path the generator writes
 * it to, so relative imports between templates resolve in place and the
 * `tsconfig.templates*.json` projects can typecheck the tree as app-shaped
 * code. Scaffolds whose files share a relative path live in separate
 * projects (`rootDirs` merges every listed scaffold into one virtual root,
 * so `auth` and `mail` cannot both ship `app/Providers/MailProvider.ts` in
 * the same project) — a new colliding scaffold gets its own
 * `tsconfig.templates-<name>.json`, chained into `typecheck:templates`.
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
