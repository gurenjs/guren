import { join } from 'node:path'
import { consola } from 'consola'
import type { WriterOptions } from './utils'
import { ensureSuffix, kebabCase, relativeImportPath, resourceName, scaffoldFile } from './utils'

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
 * Nothing discovers `app/Console/Commands` — registration is explicit so a
 * bundled deployment resolves the same commands as a local checkout. That
 * leaves a generated command dead until it is registered, so spell out the
 * one wiring step instead of letting the file sit there unused.
 */
export function printCommandRegistrationGuidance(name: string, file: string): void {
  const className = ensureSuffix(resourceName(name).className, 'Command')
  const specifier = relativeImportPath(join(process.cwd(), CONSOLE_ENTRY), file).replace(/\.ts$/u, '.js')

  consola.info(`Register it with your console kernel in ${CONSOLE_ENTRY}:`)
  consola.info(`  import ${className} from '${specifier}'`)
  consola.info(`  kernel.registerMany([${className}])`)
  consola.info(`Create ${CONSOLE_ENTRY} first if your project predates it.`)
  consola.info('See: https://guren.dev/docs/guides/console')
}
