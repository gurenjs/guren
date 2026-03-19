import type { Container } from '../container'

/**
 * Parsed argument definition.
 */
export interface ArgumentDefinition {
  name: string
  description?: string
  required: boolean
  array: boolean
  defaultValue?: string
}

/**
 * Parsed option definition.
 */
export interface OptionDefinition {
  name: string
  shortcut?: string
  description?: string
  requiresValue: boolean
  defaultValue?: string | boolean
  array: boolean
}

/**
 * Parsed signature.
 */
export interface ParsedSignature {
  name: string
  arguments: ArgumentDefinition[]
  options: OptionDefinition[]
}

/**
 * Command class type.
 */
export interface CommandClass {
  signature: string
  description: string
  new (container?: Container): CommandInstance
}

/**
 * Command instance type.
 */
export interface CommandInstance {
  setInput(argv: string[]): void
  setOutput(output: OutputInterface): void
  setKernel(kernel: { handle(argv: string[]): Promise<number> }): void
  run(): Promise<number>
}

/**
 * Output interface.
 */
export interface OutputInterface {
  info(message: string): void
  error(message: string): void
  warn(message: string): void
  success(message: string): void
  line(message: string): void
  newLine(count?: number): void
  table(headers: string[], rows: string[][]): void
  write(message: string): void
}

/**
 * Input interface.
 */
export interface InputInterface {
  argument<T = string>(name: string): T
  arguments(): Record<string, string | string[]>
  option<T = string | boolean>(name: string): T | undefined
  options(): Record<string, string | boolean | string[]>
  hasOption(name: string): boolean
}

/**
 * Console kernel options.
 */
export interface ConsoleKernelOptions {
  container?: Container
}

/**
 * Schedule definition for a command.
 */
export interface ScheduledCommand {
  command: string
  args?: string[]
  expression: string
  timezone?: string
  description?: string
}

/**
 * Interactive prompt types.
 */
export interface PromptInterface {
  ask(question: string, defaultValue?: string): Promise<string>
  confirm(question: string, defaultValue?: boolean): Promise<boolean>
  choice<T extends string>(question: string, choices: T[], defaultValue?: T): Promise<T>
  secret(question: string): Promise<string>
}

/**
 * Progress bar interface.
 */
export interface ProgressInterface {
  start(total: number): void
  advance(step?: number): void
  finish(): void
  setProgress(current: number): void
}
