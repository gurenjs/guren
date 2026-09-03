import type { Container } from '../container'
import type {
  CommandClass,
  ConsoleKernelOptions,
  OptionDefinition,
  OutputInterface,
} from './types'
import { Output, BufferedOutput } from './Output'
import { argumentLabel, formatUsage, optionLabel, parseSignature } from './Input'

/**
 * The column help text starts at: past the longest label, and never narrower
 * than `min` so that a list of short labels still reads as a column.
 */
function helpColumn(labels: string[], min: number): number {
  return Math.max(min, ...labels.map((label) => label.length + 2))
}

/**
 * Emit one help row: a label padded out to `column`, followed by whichever of
 * its annotations are present.
 */
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

/**
 * Console kernel for managing and executing commands.
 *
 * @example
 * ```typescript
 * const kernel = new ConsoleKernel()
 *
 * kernel.register(CreateUserCommand)
 * kernel.register(SendNotificationsCommand)
 *
 * // Execute command
 * const exitCode = await kernel.handle(['users:create', 'john@example.com', '--admin'])
 * ```
 */
export class ConsoleKernel {
  /**
   * Registered commands.
   */
  protected commands: Map<string, CommandClass> = new Map()

  /**
   * Service container.
   */
  protected container?: Container

  /**
   * Output instance.
   */
  protected output: OutputInterface

  constructor(options: ConsoleKernelOptions = {}) {
    this.container = options.container
    this.output = new Output()
  }

  /**
   * Register a command.
   */
  register(command: CommandClass): this {
    const parsed = parseSignature(command.signature)
    this.commands.set(parsed.name, command)
    return this
  }

  /**
   * Register multiple commands.
   */
  registerMany(commands: CommandClass[]): this {
    for (const command of commands) {
      this.register(command)
    }
    return this
  }

  /**
   * Get all registered commands.
   */
  getCommands(): Map<string, CommandClass> {
    return new Map(this.commands)
  }

  /**
   * Get a command by name.
   */
  getCommand(name: string): CommandClass | undefined {
    return this.commands.get(name)
  }

  /**
   * Check if a command is registered.
   */
  hasCommand(name: string): boolean {
    return this.commands.has(name)
  }

  /**
   * Set the output instance.
   */
  setOutput(output: OutputInterface): this {
    this.output = output
    return this
  }

  /**
   * Get the output instance.
   */
  getOutput(): OutputInterface {
    return this.output
  }

  /**
   * Handle command execution.
   */
  async handle(argv: string[] = process.argv.slice(2)): Promise<number> {
    // Parse command name from argv
    const [commandName, ...args] = argv

    // No command specified
    if (!commandName) {
      this.showHelp()
      return 0
    }

    // Built-in help command
    if (commandName === 'help' || commandName === '--help' || commandName === '-h') {
      if (args[0] && this.hasCommand(args[0])) {
        this.showCommandHelp(args[0])
      } else {
        this.showHelp()
      }
      return 0
    }

    // Built-in list command
    if (commandName === 'list') {
      this.listCommands()
      return 0
    }

    // Find command
    const CommandClass = this.commands.get(commandName)
    if (!CommandClass) {
      this.output.error(`Command not found: ${commandName}`)
      this.output.line('')
      this.suggestCommands(commandName)
      return 1
    }

    // Create and execute command
    return this.runCommand(CommandClass, args)
  }

  /**
   * Run a command.
   */
  protected async runCommand(CommandClass: CommandClass, args: string[]): Promise<number> {
    const command = new CommandClass(this.container)
    command.setInput(args)
    command.setOutput(this.output)
    command.setKernel(this)

    return command.run()
  }

  /**
   * Show help.
   */
  protected showHelp(): void {
    this.output.line('')
    this.output.info('Available Commands:')
    this.output.line('')

    // Group commands by namespace, dropping the namespace from the label
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

  /**
   * Show help for a specific command.
   */
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

    // One column for both blocks, so arguments and options line up with each other
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

  /**
   * List all commands.
   */
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

  /**
   * Group commands by namespace.
   */
  protected groupCommands(): Map<string, Map<string, CommandClass>> {
    const grouped = new Map<string, Map<string, CommandClass>>()

    // Sort commands
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

  /**
   * Suggest similar commands.
   */
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

  /**
   * Calculate string similarity (simple Dice coefficient).
   */
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

  /**
   * Call a command programmatically.
   */
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

/**
 * Create a console kernel.
 */
export function createConsoleKernel(options?: ConsoleKernelOptions): ConsoleKernel {
  return new ConsoleKernel(options)
}
