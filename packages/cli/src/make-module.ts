import { consola } from 'consola'
import { assertCwdUnsupported, camelCase, pascalCase, relativeImportPath, safeModuleName, writeScaffoldFiles, type WriterOptions } from './utils'
import { addImport, addToArrayOption } from './patch-helpers'
import { fileExists } from './discovery'

export interface MakeModuleResult {
  moduleDir: string
  filesCreated: string[]
}

/**
 * Scaffolds a `modules/<name>/` directory (RFC 0002): `index.ts` (the
 * module's public API — a `defineModule()` descriptor), `routes.ts` (an
 * empty registrar), and `db/schema.ts` (an empty table-definitions file).
 * Then patches the project's root `db/schema.ts` (re-export) and
 * `src/app.ts` (import + `modules: [...]` registration) so the module is
 * wired in immediately — both patches degrade to a warning + manual
 * instructions when the target file can't be found or parsed, never a
 * thrown error, since a scaffold shouldn't fail because of an unrelated
 * hand-edited app.ts.
 */
export async function makeModule(name: string, options: WriterOptions = {}): Promise<MakeModuleResult> {
  assertCwdUnsupported(options, 'make:module')
  const moduleName = safeModuleName(name)
  const pascalName = pascalCase(name)
  const camelName = camelCase(name)
  const moduleDir = `modules/${moduleName}`

  const indexContents = `import { defineModule } from '@guren/core'
import { register${pascalName}Routes } from './routes'

export const ${camelName}Module = defineModule({
  name: '${moduleName}',
  prefix: '/${moduleName}',
  routes: register${pascalName}Routes,
})
`

  const routesContents = `import type { Router } from '@guren/core'

export function register${pascalName}Routes(router: Router): void {
  // router.get('/', [SomeController, 'index'])
}
`

  const schemaContents = `// Define this module's Drizzle tables here.
// Re-exported into the project's db/schema.ts by \`guren make:module\`.
`

  const filesCreated = await writeScaffoldFiles(
    [
      { path: `${moduleDir}/index.ts`, contents: indexContents },
      { path: `${moduleDir}/routes.ts`, contents: routesContents },
      { path: `${moduleDir}/db/schema.ts`, contents: schemaContents },
    ],
    options,
  )

  await patchRootSchema(moduleDir)
  await patchAppEntry(moduleDir, camelName)

  return { moduleDir, filesCreated }
}

async function patchRootSchema(moduleDir: string): Promise<void> {
  const rootSchemaPath = 'db/schema.ts'
  if (!(await fileExists(process.cwd(), rootSchemaPath))) {
    consola.info(`No ${rootSchemaPath} found — skipping schema re-export wiring.`)
    return
  }

  // addImport() just inserts a line after the file's existing imports —
  // it doesn't require the inserted line to itself start with `import `,
  // so it's reused here for a `export * from ...` re-export statement.
  const reExport = `export * from '../${moduleDir}/db/schema'`
  const result = await addImport(rootSchemaPath, reExport)

  if (result.modified) {
    consola.success(`Added schema re-export to ${rootSchemaPath}`)
  } else if (result.reason === 'Import already exists') {
    consola.info(`Schema re-export already present in ${rootSchemaPath}`)
  } else {
    consola.warn(`Could not add the schema re-export automatically: ${result.reason}`)
    consola.info(`Add \`${reExport}\` to ${rootSchemaPath}.`)
  }
}

async function patchAppEntry(moduleDir: string, camelName: string): Promise<void> {
  const appPaths = ['src/app.ts', 'app.ts']
  let appPath: string | undefined

  for (const candidate of appPaths) {
    if (await fileExists(process.cwd(), candidate)) {
      appPath = candidate
      break
    }
  }

  const moduleBinding = `${camelName}Module`

  if (!appPath) {
    consola.warn('Could not find src/app.ts or app.ts — skipping auto-registration.')
    consola.info(`Import ${moduleBinding} from './${moduleDir}' and add it to createApp({ modules: [...] }) manually.`)
    return
  }

  const importPath = relativeImportPath(appPath, moduleDir)
  const moduleImport = `import { ${moduleBinding} } from '${importPath}'`

  const importResult = await addImport(appPath, moduleImport)
  if (importResult.modified) {
    consola.success(`Added ${moduleBinding} import to ${appPath}`)
  } else if (importResult.reason === 'Import already exists') {
    consola.info(`${moduleBinding} import already exists in ${appPath}`)
  }

  const modulesResult = await addToArrayOption(appPath, 'modules', moduleBinding)
  if (modulesResult.modified) {
    consola.success(`Registered ${moduleBinding} in ${appPath}`)
  } else if (modulesResult.reason === 'Already present') {
    consola.info(`${moduleBinding} already registered in ${appPath}`)
  } else {
    consola.warn(`Could not register the module automatically: ${modulesResult.reason}`)
    consola.info(`Add \`modules: [${moduleBinding}]\` to your createApp() options.`)
  }
}
