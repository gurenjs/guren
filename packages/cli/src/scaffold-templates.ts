import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScaffoldFileEntry } from './utils'

/**
 * Static scaffold templates, shipped as real sources under `templates/scaffold/`. The tree
 * mirrors the generated app — template path = written path — so relative imports resolve
 * and `tsconfig.templates*.json` typechecks it as app-shaped code; only a scaffold whose
 * templates import a companion fixture needs a `rootDirs` entry, and only those collide.
 * `scripts/check-template-configs.ts` fails when a template is covered by no project.
 */
const scaffoldTemplateDir = fileURLToPath(new URL('../templates/scaffold', import.meta.url))

/**
 * Read one shipped template, `relativePath` in POSIX form (`auth/config/mail.ts`). The
 * raw read, for assets that are not scaffold entries; prefer {@link scaffoldTemplateFile}.
 */
export function loadScaffoldTemplate(relativePath: string): string {
  return readFileSync(join(scaffoldTemplateDir, ...relativePath.split('/')), 'utf8')
}

/**
 * A writable scaffold entry: `path` is both the template path under
 * `templates/scaffold/<scaffold>/` and the written app path.
 */
export function scaffoldTemplateFile(scaffold: string, path: string): ScaffoldFileEntry {
  return { path, contents: loadScaffoldTemplate(`${scaffold}/${path}`) }
}
