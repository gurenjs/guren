// Writes `assets/plan/index.html`: the plan page template with `src/plan/page/main.ts`
// bundled into it. The package's `build` script runs it, and `files` ships `assets/`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { bundlePlanPage, composePlanTemplate } from '../src/plan/page-bundle'

const packageRoot = join(import.meta.dir, '..')
const pageDir = join(packageRoot, 'src/plan/page')
const outDir = join(packageRoot, 'assets/plan')

const html = composePlanTemplate(readFileSync(join(pageDir, 'index.html'), 'utf8'), bundlePlanPage(join(pageDir, 'main.ts')))

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'index.html'), html)
console.log(`[plan-page] wrote assets/plan/index.html (${Math.round(html.length / 1024)} KiB)`)
