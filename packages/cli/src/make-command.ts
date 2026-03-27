import type { WriterOptions } from './utils'
import { kebabCase, scaffoldFile } from './utils'

const COMMANDS_DIR = 'app/Console/Commands'

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
