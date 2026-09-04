import type { Container } from '../container'
import type {
  CommandClass,
  ConsoleKernelOptions,
  OptionDefinition,
  OutputInterface,
} from './types'
import { Command } from './Command'
import { Output, BufferedOutput } from './Output'
import { argumentLabel, formatUsage, optionLabel, parseSignature } from './Input'

/** Past the longest label, but never narrower than `min`. */
function helpColumn(labels: string[], min: number): number {
  return Math.max(min, ...labels.map((label) => label.length + 2))
}

/** A label padded out to `column`, followed by whichever annotations are present. */
function helpRow(
  output: OutputInterface,
  indent: string,
  label: string,
  column: number,
  annotations: Array<string | undefined>
): void {
  const padding = ' '.repeat(Math.max(2, column - label.length))
  output.line(`${indent}${label}${padding}${annotations.filter(Boolean).join(' ')}`)
}

/** Console kernel for managing and executing commands. */
export class ConsoleKernel {
  protected commands: Map<string, CommandClass> = new Map()

  protected container?: Container

  protected output: OutputInterface

  constructor(options: ConsoleKernelOptions = {}) {
    this.container = options.container
    this.output = new Output()
  }

  register(command: CommandClass): this {
    const parsed = parseSignature(command.signature)
    this.commands.set(parsed.name, command)
    return this
  }

  registerMany(commands: CommandClass[]): this {
    for (const command of commands) {
      this.register(command)
    }
    return this
  }

  getCommands(): Map<string, CommandClass> {
    return new Map(this.commands)
  }

  getCommand(name: string): CommandClass | undefined {
    return this.commands.get(name)
  }

  hasCommand(name: string): boolean {
    return this.commands.has(name)
  }

  setOutput(output: OutputInterface): this {
    this.output = output
    return this
  }

  getOutput(): OutputInterface {
    return this.output
  }

  async handle(argv: string[] = process.argv.slice(2)): Promise<number> {
    const [commandName, ...args] = argv

    if (!commandName) {
      this.showHelp()
      return 0
    }

    if (commandName === 'help' || commandName === '--help' || commandName === '-h') {
      if (args[0] && this.hasCommand(args[0])) {
        this.showCommandHelp(args[0])
      } else {
        this.showHelp()
      }
      return 0
    }

    if (commandName === 'list') {
      this.listCommands()
      return 0
    }

    const CommandClass = this.commands.get(commandName)
    if (!CommandClass) {
      this.output.error(`Command not found: ${commandName}`)
      this.output.line('')
      this.suggestCommands(commandName)
      return 1
    }

    return this.runCommand(CommandClass, args)
  }

  protected async runCommand(CommandClass: CommandClass, args: string[]): Promise<number> {
    const command = new CommandClass(this.container)
    command.setInput(args)
    command.setOutput(this.output)
    command.setKernel(this)

    return command.run()
  }

  protected showHelp(): void {
    this.output.line('')
    this.output.info('Available Commands:')
    this.output.line('')

    const groups = Array.from(this.groupCommands(), ([namespace, commands]) => ({
      namespace,
      entries: Array.from(commands, ([name, cmd]) => ({
        label: namespace ? name.slice(namespace.length + 1) : name,
        description: cmd.description,
      })),
    }))

    const column = helpColumn(
      groups.flatMap((group) => group.entries.map((entry) => entry.label)),
      20
    )

    for (const group of groups) {
      if (group.namespace) {
        this.output.line(`  ${group.namespace}`)
      }

      for (const entry of group.entries) {
        helpRow(this.output, '    ', entry.label, column, [entry.description])
      }

      this.output.line('')
    }
  }

  protected showCommandHelp(commandName: string): void {
    const CommandClass = this.commands.get(commandName)
    if (!CommandClass) {
      this.output.error(`Command not found: ${commandName}`)
      return
    }

    const parsed = parseSignature(CommandClass.signature)

    this.output.line('')
    this.output.info(`Command: ${commandName}`)
    this.output.line('')
    this.output.line(`  ${CommandClass.description || 'No description'}`)
    this.output.line('')
    this.output.line(`Usage: ${formatUsage(parsed)}`)

    // One column for both blocks, so arguments and options line up.
    const optionShortcut = (opt: OptionDefinition) => (opt.shortcut ? `-${opt.shortcut}, ` : '    ')
    const column = helpColumn(
      [
        ...parsed.arguments.map(argumentLabel),
        ...parsed.options.map((opt) => optionShortcut(opt) + optionLabel(opt)),
      ],
      24
    )

    if (parsed.arguments.length > 0) {
      this.output.line('')
      this.output.line('Arguments:')
      for (const arg of parsed.arguments) {
        helpRow(this.output, '  ', argumentLabel(arg), column, [
          arg.description,
          arg.required ? '(required)' : '(optional)',
          arg.defaultValue ? `[default: ${arg.defaultValue}]` : undefined,
        ])
      }
    }

    if (parsed.options.length > 0) {
      this.output.line('')
      this.output.line('Options:')
      for (const opt of parsed.options) {
        helpRow(this.output, '  ', optionShortcut(opt) + optionLabel(opt), column, [
          opt.description,
          opt.defaultValue !== undefined && opt.defaultValue !== false
            ? `[default: ${opt.defaultValue}]`
            : undefined,
        ])
      }
    }

    this.output.line('')
  }

  protected listCommands(): void {
    this.output.line('')
    this.output.info('Registered Commands:')
    this.output.line('')

    const rows: string[][] = []
    for (const [name, cmd] of this.commands) {
      rows.push([name, cmd.description || ''])
    }

    if (rows.length > 0) {
      this.output.table(['Command', 'Description'], rows)
    } else {
      this.output.line('  No commands registered.')
    }

    this.output.line('')
  }

  protected groupCommands(): Map<string, Map<string, CommandClass>> {
    const grouped = new Map<string, Map<string, CommandClass>>()

    const sorted = Array.from(this.commands.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )

    for (const [name, cmd] of sorted) {
      const colonIndex = name.indexOf(':')
      const namespace = colonIndex !== -1 ? name.slice(0, colonIndex) : ''

      if (!grouped.has(namespace)) {
        grouped.set(namespace, new Map())
      }

      grouped.get(namespace)!.set(name, cmd)
    }

    return grouped
  }

  protected suggestCommands(input: string): void {
    const similar: string[] = []

    for (const name of this.commands.keys()) {
      if (this.similarity(input, name) > 0.5) {
        similar.push(name)
      }
    }

    if (similar.length > 0) {
      this.output.line('Did you mean one of these?')
      for (const name of similar.slice(0, 3)) {
        this.output.line(`  - ${name}`)
      }
    }
  }

  /** Dice coefficient over bigrams. */
  protected similarity(a: string, b: string): number {
    const aBigrams = new Set<string>()
    for (let i = 0; i < a.length - 1; i++) {
      aBigrams.add(a.slice(i, i + 2))
    }

    let matches = 0
    for (let i = 0; i < b.length - 1; i++) {
      if (aBigrams.has(b.slice(i, i + 2))) {
        matches++
      }
    }

    return (2 * matches) / (a.length + b.length - 2)
  }

  async call(commandName: string, args: string[] = [], silent = false): Promise<number> {
    const originalOutput = this.output

    if (silent) {
      this.output = new BufferedOutput()
    }

    const result = await this.handle([commandName, ...args])

    if (silent) {
      this.output = originalOutput
    }

    return result
  }
}

export function createConsoleKernel(options?: ConsoleKernelOptions): ConsoleKernel {
  return new ConsoleKernel(options)
}
