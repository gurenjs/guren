import type { Container } from '../container'
import type { OutputInterface, CommandInstance } from './types'
import { Input } from './Input'
import { Output } from './Output'
import * as readline from 'readline'

/**
 * Base command class for console commands.
 *
 * @example
 * ```typescript
 * export class CreateUserCommand extends Command {
 *   static signature = 'users:create {email} {--admin} {--role=user}'
 *   static description = 'Create a new user'
 *
 *   async handle(): Promise<void> {
 *     const email = this.argument('email')
 *     const isAdmin = this.hasOption('admin')
 *     const role = this.option('role', 'user')
 *
 *     const password = await this.secret('Enter password:')
 *     const confirm = await this.confirm(`Create user ${email}?`)
 *
 *     if (!confirm) {
 *       this.warn('Cancelled')
 *       return
 *     }
 *
 *     this.info(`Creating user: ${email}`)
 *     this.success('User created!')
 *   }
 * }
 * ```
 */
export abstract class Command implements CommandInstance {
  /**
   * The command signature.
   * Format: 'command:name {arg} {--option}'
   */
  static signature: string

  /**
   * The command description.
   */
  static description = ''

  /**
   * The command input.
   */
  protected input!: Input

  /**
   * The command output.
   */
  protected output!: OutputInterface

  /**
   * The service container.
   */
  protected container?: Container

  constructor(container?: Container) {
    this.container = container
  }

  /**
   * Set the input for this command.
   */
  setInput(argv: string[]): void {
    const ctor = this.constructor as typeof Command
    this.input = new Input(ctor.signature, argv)
  }

  /**
   * Set the output for this command.
   */
  setOutput(output: OutputInterface): void {
    this.output = output
  }

  /**
   * Execute the command.
   */
  async run(): Promise<number> {
    try {
      const result = await this.handle()
      return typeof result === 'number' ? result : 0
    } catch (error) {
      if (error instanceof Error) {
        this.error(error.message)
      }
      return 1
    }
  }

  /**
   * Handle the command.
   * Must be implemented by subclasses.
   */
  abstract handle(): Promise<number | void>

  // ==================
  // Input Methods
  // ==================

  /**
   * Get an argument value.
   */
  argument<T = string>(name: string): T {
    return this.input.argument<T>(name)
  }

  /**
   * Get all arguments.
   */
  arguments(): Record<string, string | string[]> {
    return this.input.arguments()
  }

  /**
   * Get an option value with optional default.
   */
  option<T = string>(name: string, defaultValue?: T): T {
    const value = this.input.option<T>(name)
    return value !== undefined ? value : (defaultValue as T)
  }

  /**
   * Get all options.
   */
  options(): Record<string, string | boolean | string[]> {
    return this.input.options()
  }

  /**
   * Check if an option was provided.
   */
  hasOption(name: string): boolean {
    return this.input.hasOption(name)
  }

  // ==================
  // Output Methods
  // ==================

  /**
   * Output an info message.
   */
  info(message: string): void {
    this.output.info(message)
  }

  /**
   * Output an error message.
   */
  error(message: string): void {
    this.output.error(message)
  }

  /**
   * Output a warning message.
   */
  warn(message: string): void {
    this.output.warn(message)
  }

  /**
   * Output a success message.
   */
  success(message: string): void {
    this.output.success(message)
  }

  /**
   * Output a plain line.
   */
  line(message: string): void {
    this.output.line(message)
  }

  /**
   * Output new lines.
   */
  newLine(count = 1): void {
    this.output.newLine(count)
  }

  /**
   * Output a table.
   */
  table(headers: string[], rows: string[][]): void {
    this.output.table(headers, rows)
  }

  // ==================
  // Interactive Methods
  // ==================

  /**
   * Ask a question and get user input.
   */
  async ask(question: string, defaultValue?: string): Promise<string> {
    const rl = this.createReadline()
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `

    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close()
        resolve(answer || defaultValue || '')
      })
    })
  }

  /**
   * Ask for confirmation.
   */
  async confirm(question: string, defaultValue = false): Promise<boolean> {
    const defaultStr = defaultValue ? 'Y/n' : 'y/N'
    const answer = await this.ask(`${question} [${defaultStr}]`)

    if (!answer) {
      return defaultValue
    }

    return ['y', 'yes', 'true', '1'].includes(answer.toLowerCase())
  }

  /**
   * Present choices to the user.
   */
  async choice<T extends string>(question: string, choices: T[], defaultValue?: T): Promise<T> {
    this.line(question)
    this.newLine()

    choices.forEach((choice, index) => {
      const marker = choice === defaultValue ? '*' : ' '
      this.line(`  [${index + 1}]${marker} ${choice}`)
    })

    this.newLine()

    const answer = await this.ask('Enter choice number', defaultValue ? String(choices.indexOf(defaultValue) + 1) : '1')
    const index = parseInt(answer, 10) - 1

    if (index >= 0 && index < choices.length) {
      return choices[index]
    }

    return choices[0]
  }

  /**
   * Ask for secret input (password).
   */
  async secret(question: string): Promise<string> {
    const rl = this.createReadline()

    return new Promise((resolve) => {
      // Hide input in TTY
      const stdin = process.stdin
      if (stdin.isTTY) {
        rl.question(`${question}: `, (answer) => {
          rl.close()
          this.newLine()
          resolve(answer)
        })

        // Disable echo
        stdin.on('data', () => {
          process.stdout.write('\x1B[2K\x1B[200D' + question + ': ' + '*'.repeat(rl.line.length))
        })
      } else {
        rl.question(`${question}: `, (answer) => {
          rl.close()
          resolve(answer)
        })
      }
    })
  }

  /**
   * Create a readline interface.
   */
  protected createReadline(): readline.Interface {
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
  }

  // ==================
  // Progress Methods
  // ==================

  /**
   * Process items with progress output.
   */
  async withProgress<T>(items: T[], callback: (item: T, index: number) => Promise<void>): Promise<void> {
    const total = items.length
    const output = this.output as Output

    for (let i = 0; i < items.length; i++) {
      await callback(items[i], i)

      // Update progress
      const current = i + 1
      if (typeof output.clearLine === 'function') {
        output.clearLine()
        output.write(`Processing: ${output.progressBar(current, total)} ${current}/${total}`)
      }
    }

    if (typeof output.clearLine === 'function') {
      output.clearLine()
    }
    this.success(`Processed ${total} items`)
  }

  // ==================
  // Command Calling
  // ==================

  /**
   * Kernel reference for calling other commands.
   */
  protected kernel?: { handle(argv: string[]): Promise<number> }

  /**
   * Set the kernel reference.
   */
  setKernel(kernel: { handle(argv: string[]): Promise<number> }): void {
    this.kernel = kernel
  }

  /**
   * Call another command.
   */
  async call(command: string, args: string[] = []): Promise<number> {
    if (!this.kernel) {
      throw new Error('Kernel not set. Cannot call other commands.')
    }
    return this.kernel.handle([command, ...args])
  }

  /**
   * Call another command silently.
   */
  async callSilent(command: string, args: string[] = []): Promise<number> {
    // TODO: Implement silent output
    return this.call(command, args)
  }

  // ==================
  // Utility Methods
  // ==================

  /**
   * Resolve a service from the container.
   */
  protected resolve<T>(key: string): T {
    if (!this.container) {
      throw new Error('Container not available')
    }
    return this.container.make<T>(key)
  }

  /**
   * Get the command signature.
   */
  getSignature(): string {
    return (this.constructor as typeof Command).signature
  }

  /**
   * Get the command description.
   */
  getDescription(): string {
    return (this.constructor as typeof Command).description
  }

  /**
   * Get the command name.
   */
  getName(): string {
    return this.input?.getCommandName() ?? (this.constructor as typeof Command).signature.split(/\s+/)[0]
  }
}
