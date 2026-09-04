import { consola } from 'consola'
import { assertCwdUnsupported, camelCase, pascalCase, relativeImportPath, safeModuleName, writeScaffoldFiles, type WriterOptions } from './utils'
import { addImport, addToArrayOption, PATCH_REASONS } from './patch-helpers'
import { fileExists } from './discovery'
import { APP_ENTRY_CANDIDATES, resolveAppEntry } from './provider-registrar'

export interface MakeModuleResult {
  moduleDir: string
  filesCreated: string[]
}

/**
 * Scaffolds a `modules/<name>/` directory (RFC 0002) and wires it into the
 * project's root `db/schema.ts` and `src/app.ts`. Both patches degrade to a
 * warning plus manual instructions rather than throwing — a scaffold should
 * not fail over an unrelated hand-edited app.ts.
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

  // addImport() inserts a line after the existing imports without requiring it
  // to start with `import `, so it also serves for a re-export.
  const reExport = `export * from '../${moduleDir}/db/schema'`
  const result = await addImport(rootSchemaPath, reExport)

  if (result.modified) {
    consola.success(`Added schema re-export to ${rootSchemaPath}`)
  } else if (result.reason === PATCH_REASONS.importAlreadyExists) {
    consola.info(`Schema re-export already present in ${rootSchemaPath}`)
  } else {
    consola.warn(`Could not add the schema re-export automatically: ${result.reason}`)
    consola.info(`Add \`${reExport}\` to ${rootSchemaPath}.`)
  }
}

async function patchAppEntry(moduleDir: string, camelName: string): Promise<void> {
  const appPath = await resolveAppEntry()
  const moduleBinding = `${camelName}Module`

  if (!appPath) {
    consola.warn(`Could not find ${APP_ENTRY_CANDIDATES.join(' or ')} — skipping auto-registration.`)
    consola.info(`Import ${moduleBinding} from './${moduleDir}' and add it to createApp({ modules: [...] }) manually.`)
    return
  }

  const importPath = relativeImportPath(appPath, moduleDir)
  const moduleImport = `import { ${moduleBinding} } from '${importPath}'`

  // Registration first, import only once it lands (as in
  // `addProviderRegistration`): an import nothing references is an unused
  // local, which stops the app compiling under `noUnusedLocals`.
  const modulesResult = await addToArrayOption(appPath, 'modules', moduleBinding)
  if (modulesResult.modified) {
    consola.success(`Registered ${moduleBinding} in ${appPath}`)
  } else if (modulesResult.reason === PATCH_REASONS.alreadyPresent) {
    consola.info(`${moduleBinding} already registered in ${appPath}`)
  } else {
    consola.warn(`Could not register the module automatically: ${modulesResult.reason}`)
    consola.info(`Add \`modules: [${moduleBinding}]\` to your createApp() options.`)
    return
  }

  const importResult = await addImport(appPath, moduleImport)
  if (importResult.modified) {
    consola.success(`Added ${moduleBinding} import to ${appPath}`)
  } else if (importResult.reason === PATCH_REASONS.importAlreadyExists) {
    consola.info(`${moduleBinding} import already exists in ${appPath}`)
  }
}
