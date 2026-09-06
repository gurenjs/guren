/**
 * The one rule for wiring a framework console command into an app's kernel,
 * shared by every blueprint that ships one. Twin of provider-registrar.ts and
 * route-registrar.ts, and for the same reason those exist: a lone import breaks
 * noUnusedLocals and a lone registration is an unresolved identifier, so the
 * two edits are applied to one read and written once.
 */
import { consola } from 'consola'
import { readIfExists } from './discovery'
import { insertArrayArgument, insertImport } from './patch-helpers'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const CONSOLE_ENTRY = 'src/console.ts'

function guidance(className: string): void {
  consola.info(`Register the command in ${CONSOLE_ENTRY}:`)
  consola.info(`  import { ${className} } from '@guren/core'`)
  consola.info(`  kernel.registerMany([${className}])`)
}

/**
 * Register `className` (a `@guren/core` export) in the app's console kernel.
 * A missing entry file, or a `registerMany([...])` call this cannot find, is
 * reported with the two lines to paste rather than failing the blueprint.
 */
export async function registerConsoleCommand(className: string): Promise<void> {
  const existing = await readIfExists(process.cwd(), CONSOLE_ENTRY)
  if (existing === null) {
    consola.warn(`No ${CONSOLE_ENTRY} found — ${className} is not registered yet.`)
    guidance(className)
    return
  }

  const registered = insertArrayArgument(existing, 'registerMany', className)
  if (registered === null) {
    consola.warn(`Could not find a registerMany([...]) call in ${CONSOLE_ENTRY}.`)
    guidance(className)
    return
  }

  if (registered === existing) {
    consola.info(`${className} is already registered in ${CONSOLE_ENTRY}.`)
    return
  }

  // insertImport returns null when the statement is already there, which for a
  // just-inserted registration means the import survived an earlier run.
  const content = insertImport(registered, `import { ${className} } from '@guren/core'`) ?? registered
  await writeFile(resolve(process.cwd(), CONSOLE_ENTRY), content, 'utf8')
  consola.success(`Registered ${className} in ${CONSOLE_ENTRY}.`)
}
