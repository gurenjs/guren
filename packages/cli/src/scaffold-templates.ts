import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScaffoldFileEntry } from './utils'

/**
 * Static scaffold templates, shipped as real source files under
 * `templates/scaffold/` instead of template literals in the generator
 * modules. The tree mirrors the generated app: a template's path relative to
 * `templates/scaffold/<scaffold>/` is exactly the path the generator writes
 * it to, so relative imports between templates resolve in place and the
 * `tsconfig.templates*.json` projects can typecheck the tree as app-shaped
 * code.
 *
 * Most scaffolds sit together in `tsconfig.templates.json`; only a scaffold
 * whose templates import a *companion fixture* needs a `rootDirs` entry
 * there, and only `rootDirs`-listed scaffolds can collide (`rootDirs` merges
 * every listed dir into one virtual root, which is how the `attachments`
 * fixture's `db/schema.ts` would shadow `auth`'s — hence
 * `tsconfig.templates-attachments.json`). Two scaffolds shipping the same
 * relative path *outside* `rootDirs` coexist fine: `auth` and `mail` both
 * ship `app/Providers/MailProvider.ts` in the same project.
 * `scripts/check-template-configs.ts` (behind `typecheck:templates`)
 * discovers every `tsconfig.templates*.json` and fails when any template is
 * covered by none of them, so an exclusion without a follow-up project
 * cannot pass silently.
 *
 * Only fully static files live here. Anything whose contents vary by flags or
 * fields stays a builder function next to its generator — a template engine
 * would buy file extraction at the cost of the templates no longer being
 * valid TypeScript, which is the property this layout exists for.
 */
const scaffoldTemplateDir = fileURLToPath(new URL('../templates/scaffold', import.meta.url))

/**
 * Read one shipped template, `relativePath` in POSIX form
 * (`auth/config/mail.ts`). For TypeScript templates prefer
 * {@link scaffoldTemplateFile}; this is the raw read, for assets that are not
 * scaffold entries (guren-css.ts loads `guren-ui/resources/css/guren.css`).
 */
export function loadScaffoldTemplate(relativePath: string): string {
  return readFileSync(join(scaffoldTemplateDir, ...relativePath.split('/')), 'utf8')
}

/**
 * A writable scaffold entry for one shipped template: `path` is both the
 * template path under `templates/scaffold/<scaffold>/` and the written app
 * path — the layout invariant documented above, encoded once.
 */
export function scaffoldTemplateFile(scaffold: string, path: string): ScaffoldFileEntry {
  return { path, contents: loadScaffoldTemplate(`${scaffold}/${path}`) }
}
