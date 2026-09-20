// Writes the plan page template with `src/plan/page/main.ts` bundled into it. The
// package's `build` script runs it, and `files` ships the directory it writes to.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { composePlanPage, PLAN_ASSET_DIR, PLAN_TEMPLATE_FILE } from '../src/plan/page-bundle'

const packageRoot = join(import.meta.dir, '..')
const html = composePlanPage(join(packageRoot, 'src/plan/page'))

mkdirSync(join(packageRoot, PLAN_ASSET_DIR), { recursive: true })
writeFileSync(join(packageRoot, PLAN_ASSET_DIR, PLAN_TEMPLATE_FILE), html)
console.log(`[plan-page] wrote ${PLAN_ASSET_DIR}/${PLAN_TEMPLATE_FILE} (${Math.round(html.length / 1024)} KiB)`)
