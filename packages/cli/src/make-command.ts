import { join } from 'node:path'
import { consola } from 'consola'
import type { WriterOptions } from './utils'
import { camelCase, ensureSuffix, kebabCase, relativeImportPath, resourceName, safeModuleName, scaffoldFile } from './utils'
import { addImport, addToArrayArgument, addToArrayOption, PATCH_REASONS } from './patch-helpers'
import { fileExists, readIfExists } from './discovery'
import { registersCommandsOf } from './console-check'

const COMMANDS_DIR = 'app/Console/Commands'
const CONSOLE_ENTRY = 'src/console.ts'

function commandTemplate(className: string, commandName: string): string {
  return `import { Command } from '@guren/core'

export default class ${className} extends Command {
  static signature = '${commandName}'
  static description = 'Command description'

  async handle(): Promise<void> {
    this.info('Done!')
  }
}
`
}

export interface MakeCommandOptions extends WriterOptions {
  command?: string
}

export async function makeCommand(name: string, options: MakeCommandOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: COMMANDS_DIR,
    suffix: 'Command',
    template: ({ normalizedName }) => {
      const commandName = options.command ?? kebabCase(normalizedName.replace(/Command$/, ''))
      return commandTemplate(normalizedName, commandName)
    },
  }, options)
}

/**
 * The source is `.ts` but a project's own imports are written `.js`, matching
 * the console templates and the module scaffolds.
 */
function commandSpecifier(fromFile: string, file: string): string {
  return relativeImportPath(join(process.cwd(), fromFile), file).replace(/\.ts$/u, '.js')
}

/**
 * Registers a scaffolded command with its console kernel: `src/console.ts`, or the
 * owning module's `defineModule({ commands: [...] })` under `--module`. Nothing
 * discovers `app/Console/Commands` at runtime (so a bundled deployment matches a
 * checkout), so an unwired command is dead; a patch that cannot apply prints the
 * manual step. Takes only `root` because `patch-helpers` still resolves against `process.cwd()`.
 */
export async function registerScaffoldedCommand(
  name: string,
  file: string,
  options: Pick<MakeCommandOptions, 'root'> = {},
): Promise<void> {
  const className = ensureSuffix(resourceName(name).className, 'Command')

  if (options.root) {
    await registerModuleCommand(className, file, safeModuleName(options.root))
    return
  }

  await registerRootCommand(className, file)
}

async function registerRootCommand(className: string, file: string): Promise<void> {
  const specifier = commandSpecifier(CONSOLE_ENTRY, file)

  if (!(await fileExists(process.cwd(), CONSOLE_ENTRY))) {
    consola.warn(`No ${CONSOLE_ENTRY} found — ${className} is not registered yet.`)
    printRootRegistrationGuidance(className, specifier)
    return
  }

  // Patch the registration before the import, so a failure here can't leave
  // an unused import behind.
  const registration = await addToArrayArgument(CONSOLE_ENTRY, 'registerMany', className)

  if (!registration.modified && registration.reason !== PATCH_REASONS.alreadyPresent) {
    consola.warn(`Could not register ${className} automatically: ${registration.reason}`)
    printRootRegistrationGuidance(className, specifier)
    return
  }

  await addImport(CONSOLE_ENTRY, `import ${className} from '${specifier}'`)

  if (registration.modified) {
    consola.success(`Registered ${className} in ${CONSOLE_ENTRY}`)
  } else {
    consola.info(`${className} is already registered in ${CONSOLE_ENTRY}`)
  }
}

async function registerModuleCommand(className: string, file: string, moduleName: string): Promise<void> {
  const indexPath = `modules/${moduleName}/index.ts`
  const specifier = commandSpecifier(indexPath, file)

  if (!(await fileExists(process.cwd(), indexPath))) {
    consola.warn(`No ${indexPath} found — ${className} is not registered yet.`)
    consola.info(`Add it to defineModule({ commands: [...] }) in ${indexPath}:`)
    consola.info(`  import ${className} from '${specifier}'`)
    consola.info(`  commands: [${className}]`)
    return
  }

  const registration = await addToArrayOption(indexPath, 'commands', className, 'defineModule')

  if (!registration.modified && registration.reason !== PATCH_REASONS.alreadyPresent) {
    consola.warn(`Could not register ${className} automatically: ${registration.reason}`)
    consola.info(`Add \`commands: [${className}]\` to defineModule() in ${indexPath}, importing it from '${specifier}'.`)
    return
  }

  await addImport(indexPath, `import ${className} from '${specifier}'`)

  if (registration.modified) {
    consola.success(`Registered ${className} in ${indexPath}`)
  } else {
    consola.info(`${className} is already registered in ${indexPath}`)
  }

  await printModuleConsoleHopGuidance(moduleName)
}

/**
 * The one step `make:command` cannot patch: `kernel.registerMany(<module>
 * .commands)` is a statement, not an entry in an existing array. Printed only
 * when that line is absent, so a project that already made the hop stays quiet.
 */
async function printModuleConsoleHopGuidance(moduleName: string): Promise<void> {
  const moduleBinding = `${camelCase(moduleName)}Module`
  const consoleSource = await readIfExists(process.cwd(), CONSOLE_ENTRY)

  // Same test `guren check` applies, so the two never disagree about whether
  // this step is still outstanding.
  if (consoleSource !== null && registersCommandsOf(consoleSource, [moduleBinding])) return

  consola.info(`Register the module's commands with your console kernel in ${CONSOLE_ENTRY}:`)
  consola.info(`  import { ${moduleBinding} } from '../modules/${moduleName}/index.js'`)
  consola.info(`  kernel.registerMany(${moduleBinding}.commands)`)
  if (consoleSource === null) {
    consola.info(`Create ${CONSOLE_ENTRY} first if your project predates it.`)
  }
  consola.info('See: https://guren.dev/docs/guides/console')
}

function printRootRegistrationGuidance(className: string, specifier: string): void {
  consola.info(`Register it with your console kernel in ${CONSOLE_ENTRY}:`)
  consola.info(`  import ${className} from '${specifier}'`)
  consola.info(`  kernel.registerMany([${className}])`)
  consola.info('See: https://guren.dev/docs/guides/console')
}
