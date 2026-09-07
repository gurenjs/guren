import type { Container } from '../container'
import type { OutputInterface, CommandInstance } from './types'
import { Input } from './Input'
import { Output } from './Output'
import * as readline from 'readline'

/** Base class for console commands. */
export abstract class Command implements CommandInstance {
  /**
   * Format: `command:name {arg} {--option}`, tokens optionally carrying a
   * description (`{arg : What it is}`). See `parseSignature` for the grammar.
   */
  static signature: string

  static description = ''

  protected input!: Input

  protected output!: OutputInterface

  protected container?: Container

  constructor(container?: Container) {
    this.container = container
  }

  setInput(argv: string[]): void {
    const ctor = this.constructor as typeof Command
    this.input = new Input(ctor.signature, argv)
  }

  setOutput(output: OutputInterface): void {
    this.output = output
  }

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

  abstract handle(): Promise<number | void>

  argument<T = string>(name: string): T {
    return this.input.argument<T>(name)
  }

  arguments(): Record<string, string | string[]> {
    return this.input.arguments()
  }

  option<T = string>(name: string, defaultValue?: T): T {
    const value = this.input.option<T>(name)
    return value !== undefined ? value : (defaultValue as T)
  }

  options(): Record<string, string | boolean | string[]> {
    return this.input.options()
  }

  hasOption(name: string): boolean {
    return this.input.hasOption(name)
  }

  info(message: string): void {
    this.output.info(message)
  }

  error(message: string): void {
    this.output.error(message)
  }

  warn(message: string): void {
    this.output.warn(message)
  }

  success(message: string): void {
    this.output.success(message)
  }

  line(message: string): void {
    this.output.line(message)
  }

  newLine(count = 1): void {
    this.output.newLine(count)
  }

  table(headers: string[], rows: string[][]): void {
    this.output.table(headers, rows)
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    const answer = await this.prompt(
      defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `,
      { mask: false }
    )

    return answer || defaultValue || ''
  }

  async confirm(question: string, defaultValue = false): Promise<boolean> {
    const defaultStr = defaultValue ? 'Y/n' : 'y/N'
    const answer = await this.ask(`${question} [${defaultStr}]`)

    if (!answer) {
      return defaultValue
    }

    return ['y', 'yes', 'true', '1'].includes(answer.toLowerCase())
  }

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
   *
   * Rejects when input ends with nothing typed: unlike the other prompts there
   * is no safe default for a password.
   */
  async secret(question: string): Promise<string> {
    const answer = await this.prompt(`${question}: `, { mask: true })

    if (answer === null) {
      throw new Error(`Input closed before "${question}" was answered`)
    }

    return answer
  }

  /**
   * Run one readline prompt to completion. Settles exactly once, and tears the
   * interface, the mask listener and raw mode down on every exit path, so a
   * later prompt starts clean. Returns null when input ended with nothing
   * typed; callers decide what that means, as leaving it unanswered would hang.
   */
  private prompt(prompt: string, options: { mask: boolean }): Promise<string | null> {
    const stdin = this.inputStream()
    const stdout = this.outputStream()
    const rl = this.createReadline()
    const hideInput = options.mask && stdin.isTTY === true

    return new Promise((resolve) => {
      let settled = false

      // Overwrites the line readline just echoed, so it has to target the same
      // stream readline writes to. The settled check is load-bearing:
      // EventEmitter snapshots its listener array before dispatch, so the `off`
      // in finish() cannot stop a mask call already scheduled in the same
      // 'data' emit — the newline ending the prompt would repaint an empty mask.
      const mask = (): void => {
        if (settled) return
        stdout.write('\x1B[2K\x1B[200D' + prompt + '*'.repeat(rl.line.length))
      }

      const finish = (): void => {
        settled = true
        stdin.off('data', mask)
        rl.close()
        if (hideInput && typeof stdin.setRawMode === 'function') {
          stdin.setRawMode(false)
        }
      }

      if (hideInput) {
        stdin.on('data', mask)
      }

      // Input can end without a trailing newline, and Bun's readline then
      // closes without ever delivering a line.
      rl.once('close', () => {
        if (settled) return
        const buffered = rl.line
        finish()
        if (hideInput && buffered) {
          this.newLine()
        }
        resolve(buffered || null)
      })

      rl.question(prompt, (answer) => {
        if (settled) return
        finish()
        if (hideInput) {
          this.newLine()
        }
        resolve(answer)
      })
    })
  }

  /** The stream prompts read from. Overridable so a test can hand the command a fake terminal. */
  protected inputStream(): NodeJS.ReadStream {
    return process.stdin
  }

  /**
   * The stream prompts are echoed to. Derived from the output `setOutput()`
   * installed, so redirecting a command's output redirects its prompts too.
   */
  protected outputStream(): NodeJS.WriteStream {
    return this.output?.stream?.() ?? process.stdout
  }

  protected createReadline(): readline.Interface {
    return readline.createInterface({
      input: this.inputStream(),
      output: this.outputStream(),
    })
  }

  async withProgress<T>(items: T[], callback: (item: T, index: number) => Promise<void>): Promise<void> {
    const total = items.length
    const output = this.output as Output

    for (let i = 0; i < items.length; i++) {
      await callback(items[i], i)

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

  protected kernel?: { handle(argv: string[]): Promise<number> }

  setKernel(kernel: { handle(argv: string[]): Promise<number> }): void {
    this.kernel = kernel
  }

  async call(command: string, args: string[] = []): Promise<number> {
    if (!this.kernel) {
      throw new Error('Kernel not set. Cannot call other commands.')
    }
    return this.kernel.handle([command, ...args])
  }

  protected resolve<T>(key: string): T {
    if (!this.container) {
      throw new Error('Container not available')
    }
    return this.container.make<T>(key)
  }

  /** `resolve()` for a service a command tolerates being absent; fakes and deferred providers count. */
  protected resolveOptional<T>(key: string): T | undefined {
    return this.container?.makeOptional<T>(key)
  }

  getSignature(): string {
    return (this.constructor as typeof Command).signature
  }

  getDescription(): string {
    return (this.constructor as typeof Command).description
  }

  getName(): string {
    return this.input?.getCommandName() ?? (this.constructor as typeof Command).signature.split(/\s+/)[0]
  }
}
