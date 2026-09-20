import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { composePlanPage, PLAN_ASSET_DIR, PLAN_TEMPLATE_FILE } from './page-bundle'

export interface PlanAsset {
  path: string
  source: string
}

const cache = new Map<string, PlanAsset>()
// Apart from `cache`: a built page read as a plain asset must never answer for the one composed from source.
const composed = new Map<string, PlanAsset>()

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * A file under `assets/plan/`, read once per process. The chunk this module is bundled
 * into sits at `dist/`, one hop below the package root; the source sits at `src/plan/`,
 * two. Both are tried rather than probed with `existsSync`, which reports a permission
 * error on a parent as absence.
 */
export function readPlanAsset(name: string): PlanAsset {
  const hit = cache.get(name)
  if (hit !== undefined) return hit

  const tried: string[] = []
  for (const up of ['../', '../../']) {
    const path = fileURLToPath(new URL(`${up}${PLAN_ASSET_DIR}/${name}`, import.meta.url))
    try {
      const asset = { path, source: readFileSync(path, 'utf8') }
      cache.set(name, asset)
      return asset
    } catch (error) {
      if (!isMissing(error)) throw error
      tried.push(path)
    }
  }

  throw new Error(`Could not locate ${name} of the plan page shipped with @guren/cli. Tried:\n  ${tried.join('\n  ')}`)
}

/**
 * The page template with its script in place. `page/` sits beside this module only in
 * the source tree, and there the template is composed on every run, so nothing run from
 * source reads a build that has gone stale. The published package ships the composed
 * file under `assets/plan/` and no `page/`. `pageDir` is a test seam.
 */
export function readPlanTemplate(pageDir = fileURLToPath(new URL('./page/', import.meta.url))): PlanAsset {
  const hit = composed.get(pageDir)
  if (hit !== undefined) return hit

  let source: string
  try {
    source = composePlanPage(pageDir)
  } catch (error) {
    if (!isMissing(error)) throw error
    return readPlanAsset(PLAN_TEMPLATE_FILE)
  }
  const asset = { path: join(pageDir, PLAN_TEMPLATE_FILE), source }
  composed.set(pageDir, asset)
  return asset
}
