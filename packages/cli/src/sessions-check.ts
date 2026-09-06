/**
 * Session wiring checks (RFC 0020 §2). Both failures are invisible until
 * runtime: a config nothing binds leaves sessions on the in-memory default,
 * which works locally and drops every login on a serverless target; a
 * `database` store whose table the schema does not export throws on the first
 * write. Content-activated — an app with no session config contributes nothing.
 */
import { relative } from 'node:path'
import type { ObjectExpression } from '@babel/types'
import { objectLiteral, walk, type BabelNode } from './ast-walk'
import { SCHEMA_SPECIFIER_PATTERN, schemaModuleFor } from './attachments-check'
import { check, type CheckResult } from './check-result'
import { appBindsService } from './discovery'
import type { ParseCache, ParsedFile } from './parse-cache'
import type { SchemaTable } from './schema-parser'

const SESSION_CONFIG_TYPE = 'SessionConfig'
const GUREN_PACKAGE_PREFIX = '@guren/'

/** Local binding → the exported name it aliases, for value and type imports alike. */
function importsByLocal(parsed: ParsedFile): Map<string, { source: string; imported: string }> {
  const imports = new Map<string, { source: string; imported: string }>()
  for (const statement of parsed.ast.program.body) {
    if (statement.type !== 'ImportDeclaration') continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue
      const imported = specifier.imported
      imports.set(specifier.local.name, {
        source: statement.source.value,
        imported: imported.type === 'Identifier' ? imported.name : imported.value,
      })
    }
  }
  return imports
}

function propertyValue(object: ObjectExpression, name: string): BabelNode | undefined {
  for (const property of object.properties as unknown as BabelNode[]) {
    if (property.type !== 'ObjectProperty' || property.computed) continue
    const key = property.key as BabelNode
    const keyName = key?.type === 'Identifier' ? key.name : key?.type === 'StringLiteral' ? key.value : undefined
    if (keyName === name) return property.value as BabelNode
  }
  return undefined
}

/** Every `SessionConfig`-annotated object in a file, with the line it starts on. */
function sessionConfigs(parsed: ParsedFile): Array<{ config: ObjectExpression; line: number }> {
  const locals = importsByLocal(parsed)
  const found: Array<{ config: ObjectExpression; line: number }> = []

  walk(parsed.ast.program, (node) => {
    if (node.type !== 'VariableDeclarator') return
    const id = node.id as BabelNode
    const annotation = (id?.typeAnnotation as BabelNode | undefined)?.typeAnnotation as BabelNode | undefined
    if (annotation?.type !== 'TSTypeReference') return
    const typeName = annotation.typeName as BabelNode
    if (typeName?.type !== 'Identifier') return
    const entry = locals.get(typeName.name as string)
    if (!entry || entry.imported !== SESSION_CONFIG_TYPE || !entry.source.startsWith(GUREN_PACKAGE_PREFIX)) return
    const config = objectLiteral(node.init as never)
    if (config) found.push({ config, line: node.loc?.start.line ?? 0 })
  })

  return found
}

export async function checkSessionsConfig(options: {
  cwd: string
  cache: ParseCache
  files: string[]
  schemaTables: SchemaTable[]
}): Promise<CheckResult[]> {
  const { cwd, cache, files, schemaTables } = options
  const results: CheckResult[] = []
  let sawConfig = false

  for (const filePath of files) {
    const source = await cache.source(filePath)
    if (!source || !source.includes(SESSION_CONFIG_TYPE)) continue

    const parsed = await cache.get(filePath)
    if (!parsed) continue

    const configs = sessionConfigs(parsed)
    if (configs.length === 0) continue
    sawConfig = true

    const relPath = relative(cwd, filePath)
    const locals = importsByLocal(parsed)

    for (const { config } of configs) {
      const stores = objectLiteral(propertyValue(config, 'stores') as never)
      for (const entry of (stores?.properties ?? []) as unknown as BabelNode[]) {
        if (entry.type !== 'ObjectProperty') continue
        const store = objectLiteral(entry.value as never)
        if (!store) continue

        const driver = propertyValue(store, 'driver')
        if (driver?.type !== 'StringLiteral' || driver.value !== 'database') continue

        const table = propertyValue(store, 'table')
        // Only a named import from a db/schema module can be judged against the
        // parsed schema; a table built inline or imported elsewhere is out of sight.
        if (table?.type !== 'Identifier') continue
        const importEntry = locals.get(table.name as string)
        if (!importEntry || !SCHEMA_SPECIFIER_PATTERN.test(importEntry.source)) continue

        const schemaModule = schemaModuleFor(cwd, filePath, importEntry.source)
        if (schemaModule === undefined) continue

        const tableName = importEntry.imported
        const declared = schemaTables.some(
          (candidate) => candidate.identifier === tableName && candidate.module === schemaModule,
        )
        const key = `sessions-config:${relPath}:${tableName}`
        const title = 'Session store table'
        if (declared) {
          results.push(check(key, title, 'pass', `The database session store binds schema table '${tableName}'.`))
          continue
        }
        results.push(
          check(
            key,
            title,
            'fail',
            `${relPath} binds the database session store to '${tableName}' from ${importEntry.source}, but no schema `
              + `module declares a table with that export. The store takes the table untyped, so this only fails at `
              + `runtime, on the first request that writes a session.`,
            `Run \`bunx guren add session\` to add the sessions table, or point the store at the table your schema does export.`,
            relPath,
          ),
        )
      }
    }
  }

  if (!sawConfig) {
    return results
  }

  // The config is inert without it: AuthServiceProvider reads the manager from
  // the container, and finds the in-memory default when nothing bound one.
  if (await appBindsService('session', cwd)) {
    results.push(check('sessions-binding', 'Session manager binding', 'pass', "A provider binds 'session'."))
  } else {
    results.push(
      check(
        'sessions-binding',
        'Session manager binding',
        'warn',
        "A session config exists, but no provider binds 'session', so the config is never read and sessions stay "
          + 'on the in-memory default — every login lost between requests on Workers, Lambda and Vercel.',
        "Register a provider whose register() calls container.instance('session', createSessionManager(sessionConfig)), "
          + 'and list it in createApp({ providers }). `bunx guren add session` writes one.',
      ),
    )
  }

  return results
}
