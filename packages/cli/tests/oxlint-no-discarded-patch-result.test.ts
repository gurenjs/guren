import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
// @ts-expect-error TS7016: the plugin is JavaScript for oxlint's Node loader and ships no declarations
import { PATCH_RESULT_FUNCTIONS } from '../src/oxlint/no-discarded-patch-result.js'
import { lintFixture } from './helpers'

// Exercised through the real oxlint binary, like the sibling rules: what has to
// hold is that the plugin loads and reports on the AST oxlint hands it.

const plugin = resolve(import.meta.dir, '../src/oxlint/no-discarded-patch-result.js')
const srcDir = resolve(import.meta.dir, '../src')

function lint(source: string): string {
  return lintFixture({
    config: { jsPlugins: [plugin], rules: { 'guren-no-discarded-patch-result/no-discarded-patch-result': 'error' } },
    file: 'case.ts',
    source,
  })
}

/** Lines of `output` the rule reports, in the order oxlint prints them. */
function linesIn(output: string): number[] {
  return [...output.matchAll(/^case\.ts:(\d+):\d+: .*no-discarded-patch-result/gm)].map((m) => Number(m[1]))
}

const reportedLines = (source: string): number[] => linesIn(lint(source))

describe('guren/no-discarded-patch-result', () => {
  test('reports a discarded call to every helper, however the statement wraps it, naming what to read', () => {
    const output = lint(`import { addImport, addToArrayOption, addToArrayArgument, addCreateAppOption } from './patch-helpers'
import { addRouteRegistrarCall } from './route-registrar'
await addImport('src/app.ts', "import x from './x'")
addImport('src/app.ts', "import x from './x'")
void addImport('src/app.ts', "import x from './x'")
void (await addImport('src/app.ts', "import x from './x'"))
;(await addToArrayOption('src/app.ts', 'modules', 'm'))
await addToArrayArgument('src/console.ts', 'registerMany', 'C')
await addCreateAppOption('src/app.ts', 'auth', '{}')
await addRouteRegistrarCall('routes/web.ts', 'registerAdminRoutes', "import a from './admin.js'")
`)
    expect(linesIn(output)).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    expect(output).toContain('`addImport()` reports a patch it could not apply in its PatchResult, and this statement discards it. Read `.modified` / `.reason` (PATCH_REASONS) before reporting success.')
  })

  test('follows an alias, a namespace import and a .js specifier', () => {
    expect(reportedLines(`import { addImport as patchImport } from '../patch-helpers.js'
import * as patch from './patch-helpers'
await patchImport('src/app.ts', "import x from './x'")
await patch.addToArrayOption('src/app.ts', 'modules', 'm')
await patch.insertImport('src/app.ts', "import x from './x'")
`)).toEqual([3, 4])
  })

  test('leaves alone a result that is read, and a same-named function from elsewhere', () => {
    expect(reportedLines(`import { addImport } from './patch-helpers'
import { addToArrayOption } from './other-helpers'
import type { addCreateAppOption } from './patch-helpers'
const result = await addImport('src/app.ts', "import x from './x'")
if (!(await addImport('src/app.ts', "import x from './x'")).modified) throw new Error('x')
export async function wire(): Promise<unknown> {
  return addImport('src/app.ts', "import x from './x'")
}
const landed = [await addImport('src/app.ts', "import x from './x'")]
await addToArrayOption('src/app.ts', 'modules', 'm')
console.log(result, landed)
`)).toEqual([])
  })

  test('the table names exactly the exports typed Promise<PatchResult> or Promise<EntryWiring> under src/', async () => {
    const files = (await readdir(srcDir)).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    const scanned = await Promise.all(files.map(async (file) => {
      const source = await readFile(join(srcDir, file), 'utf8')
      const names = [...source.matchAll(/^export async function (\w+)\([^{]*?\): Promise<(?:PatchResult|EntryWiring)>/gmu)].map((m) => m[1]!)
      return [file.replace(/\.ts$/u, ''), names.sort()] as const
    }))
    const found = Object.fromEntries(scanned.filter(([, names]) => names.length > 0))
    const table = Object.fromEntries(
      Object.entries(PATCH_RESULT_FUNCTIONS as Record<string, string[]>).map(([k, v]) => [k, [...v].sort()]),
    )
    expect(table).toEqual(found)
  })
})
