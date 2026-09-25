import { consola } from 'consola'
import { assertCwdUnsupported, camelCase, pascalCase, relativeImportPath, safeModuleName, writeScaffoldFiles, type WriterOptions } from './utils'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { addImport, addToArrayOption, composeEntryWithImport, insertImport, PATCH_REASONS, spreadModuleIntoSchema } from './patch-helpers'
import { readIfExists } from './discovery'
import { MODULE_ENTRY_FILE, MODULE_ROUTES_FILE } from './import-resolution'
import { moduleSchemaAggregateName, moduleSchemaSpecifier, schemaPathFor } from './schema-parser'
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

  // A root schema object is what drizzle is handed, so the module keeps its own for the
  // root to spread; without one, `export {}` keeps the file a module: the root schema's
  // `export *` fails on a script (TS2306).
  const rootSchema = await readIfExists(process.cwd(), schemaPathFor(null))
  const aggregate = moduleSchemaAggregateName(moduleName)
  const spread = rootSchema === null ? null : spreadModuleIntoSchema(rootSchema, moduleName, aggregate)
  const keepsAggregate = spread !== null && (spread.content !== undefined || spread.reason === PATCH_REASONS.alreadyPresent)
  const schemaContents = keepsAggregate
    ? `// Define this module's Drizzle tables here and list each one in ${aggregate},
// which the project's db/schema.ts spreads into its schema object.
export const ${aggregate} = {}
`
    : `// Define this module's Drizzle tables here.
// Re-exported into the project's db/schema.ts by \`guren make:module\`.
export {}
`

  const filesCreated = await writeScaffoldFiles(
    [
      { path: `${moduleDir}/${MODULE_ENTRY_FILE}`, contents: indexContents },
      { path: `${moduleDir}/${MODULE_ROUTES_FILE}`, contents: routesContents },
      { path: `${moduleDir}/db/schema.ts`, contents: schemaContents },
    ],
    { ...options, subject: moduleDir },
  )

  await patchRootSchema(moduleName, rootSchema, keepsAggregate ? aggregate : null)
  await patchAppEntry(moduleDir, camelName)

  return { moduleDir, filesCreated }
}

/**
 * One write of the root schema: the module's re-export, and, when the root keeps a schema
 * object, `...aggregate` spread into it with its import.
 */
async function patchRootSchema(moduleName: string, source: string | null, aggregate: string | null): Promise<void> {
  const rootSchemaPath = schemaPathFor(null)
  if (source === null) {
    consola.info(`No ${rootSchemaPath} found — skipping schema re-export wiring.`)
    return
  }

  const specifier = moduleSchemaSpecifier(moduleName)
  // insertImport() inserts a line after the existing imports without requiring it
  // to start with `import `, so it also serves for a re-export.
  const reExported = insertImport(source, `export * from '${specifier}'`)
  let content = reExported ?? source
  if (reExported !== null) consola.success(`Added schema re-export to ${rootSchemaPath}`)
  else consola.info(`Schema re-export already present in ${rootSchemaPath}`)

  if (aggregate) {
    const { wiring, content: spread } = composeEntryWithImport(content, (current) => {
      const entry = spreadModuleIntoSchema(current, moduleName, aggregate)
      return { entry, importStatement: entry.content === undefined ? null : `import { ${aggregate} } from '${specifier}'` }
    })
    content = spread ?? content
    if (wiring.entry.modified) {
      consola.success(`Spread ${aggregate} into the schema object in ${rootSchemaPath}`)
    } else if (wiring.registered) {
      consola.info(`The schema object in ${rootSchemaPath} already spreads modules/${moduleName}'s tables`)
    } else {
      consola.warn(`Could not spread ${aggregate} into the schema object automatically: ${wiring.entry.reason}`)
      consola.info(`Import ${aggregate} from '${specifier}' in ${rootSchemaPath} and add \`...${aggregate}\` to its schema object.`)
    }
  }

  if (content !== source) await writeFile(resolve(process.cwd(), rootSchemaPath), content, 'utf8')
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
  // `addArrayOptionRegistration`): an import nothing references is an unused
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
