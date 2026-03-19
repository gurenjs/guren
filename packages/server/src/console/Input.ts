import type {
  ParsedSignature,
  ArgumentDefinition,
  OptionDefinition,
  InputInterface,
} from './types'

/**
 * Parse a command signature into argument and option definitions.
 *
 * Signature format:
 * - `command:name` - Command name
 * - `{argument}` - Required argument
 * - `{argument?}` - Optional argument
 * - `{argument=default}` - Argument with default
 * - `{argument*}` - Array argument (must be last)
 * - `{--option}` - Boolean option (flag)
 * - `{--option=}` - Option that requires a value
 * - `{--option=default}` - Option with default value
 * - `{-o|--option}` - Option with shortcut
 * - `{--option=*}` - Array option
 *
 * @example
 * ```typescript
 * parseSignature('users:create {name} {--admin} {--role=user}')
 * // => {
 * //   name: 'users:create',
 * //   arguments: [{ name: 'name', required: true, array: false }],
 * //   options: [
 * //     { name: 'admin', requiresValue: false },
 * //     { name: 'role', requiresValue: true, defaultValue: 'user' }
 * //   ]
 * // }
 * ```
 */
export function parseSignature(signature: string): ParsedSignature {
  const parts = signature.split(/\s+/)
  const name = parts[0]
  const args: ArgumentDefinition[] = []
  const options: OptionDefinition[] = []

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]

    // Skip empty parts
    if (!part) continue

    // Must be wrapped in braces
    if (!part.startsWith('{') || !part.endsWith('}')) {
      continue
    }

    const content = part.slice(1, -1).trim()

    if (content.startsWith('--') || content.startsWith('-')) {
      // Option
      options.push(parseOption(content))
    } else {
      // Argument
      args.push(parseArgument(content))
    }
  }

  return { name, arguments: args, options }
}

/**
 * Parse an argument definition.
 */
function parseArgument(content: string): ArgumentDefinition {
  let name = content
  let required = true
  let array = false
  let defaultValue: string | undefined

  // Check for array argument
  if (name.endsWith('*')) {
    array = true
    name = name.slice(0, -1)
  }

  // Check for optional argument
  if (name.endsWith('?')) {
    required = false
    name = name.slice(0, -1)
  }

  // Check for default value
  const eqIndex = name.indexOf('=')
  if (eqIndex !== -1) {
    defaultValue = name.slice(eqIndex + 1)
    name = name.slice(0, eqIndex)
    required = false
  }

  // Extract description if present (after :)
  let description: string | undefined
  const colonIndex = name.indexOf(':')
  if (colonIndex !== -1) {
    description = name.slice(colonIndex + 1)
    name = name.slice(0, colonIndex)
  }

  return { name, description, required, array, defaultValue }
}

/**
 * Parse an option definition.
 */
function parseOption(content: string): OptionDefinition {
  let name = content
  let shortcut: string | undefined
  let requiresValue = false
  let defaultValue: string | boolean | undefined
  let array = false

  // Remove leading dashes for processing
  name = name.replace(/^-+/, '')

  // Check for shortcut (e.g., -o|--option)
  if (name.includes('|')) {
    const [short, long] = name.split('|')
    shortcut = short.replace(/^-*/, '')
    name = long.replace(/^-+/, '')
  }

  // Check for array option
  if (name.endsWith('=*')) {
    array = true
    requiresValue = true
    name = name.slice(0, -2)
  } else if (name.endsWith('=')) {
    // Option requires a value but no default
    requiresValue = true
    name = name.slice(0, -1)
  } else {
    // Check for default value
    const eqIndex = name.indexOf('=')
    if (eqIndex !== -1) {
      defaultValue = name.slice(eqIndex + 1)
      name = name.slice(0, eqIndex)
      requiresValue = true
    }
  }

  // Extract description if present
  let description: string | undefined
  const colonIndex = name.indexOf(':')
  if (colonIndex !== -1) {
    description = name.slice(colonIndex + 1)
    name = name.slice(0, colonIndex)
  }

  // Boolean options default to false
  if (!requiresValue && defaultValue === undefined) {
    defaultValue = false
  }

  return { name, shortcut, description, requiresValue, defaultValue, array }
}

/**
 * Console input handler.
 *
 * @example
 * ```typescript
 * const input = new Input('users:create {name} {--admin}', ['John', '--admin'])
 * input.argument('name') // => 'John'
 * input.option('admin') // => true
 * ```
 */
export class Input implements InputInterface {
  /**
   * Parsed signature.
   */
  protected parsed: ParsedSignature

  /**
   * Parsed argument values.
   */
  protected argumentValues: Record<string, string | string[]> = {}

  /**
   * Parsed option values.
   */
  protected optionValues: Record<string, string | boolean | string[]> = {}

  constructor(signature: string, argv: string[] = []) {
    this.parsed = parseSignature(signature)
    this.parseArgv(argv)
  }

  /**
   * Parse command line arguments.
   */
  protected parseArgv(argv: string[]): void {
    const args: string[] = []
    let i = 0

    // Initialize options with defaults
    for (const opt of this.parsed.options) {
      if (opt.defaultValue !== undefined) {
        this.optionValues[opt.name] = opt.defaultValue
      }
    }

    // Initialize array options
    for (const opt of this.parsed.options) {
      if (opt.array) {
        this.optionValues[opt.name] = []
      }
    }

    while (i < argv.length) {
      const arg = argv[i]

      if (arg.startsWith('--')) {
        // Long option
        this.parseLongOption(arg.slice(2), argv, i)
        if (arg.includes('=') || !this.optionRequiresValue(arg.slice(2).split('=')[0])) {
          i++
        } else {
          i += 2 // Skip option and its value
        }
      } else if (arg.startsWith('-') && arg.length > 1) {
        // Short option
        this.parseShortOption(arg.slice(1), argv, i)
        const shortName = arg.slice(1)
        const optDef = this.findOptionByShortcut(shortName)
        if (optDef?.requiresValue && !arg.includes('=')) {
          i += 2
        } else {
          i++
        }
      } else {
        // Positional argument
        args.push(arg)
        i++
      }
    }

    // Map positional arguments to definitions
    this.mapArguments(args)
  }

  /**
   * Parse a long option.
   */
  protected parseLongOption(option: string, argv: string[], index: number): void {
    let name = option
    let value: string | undefined

    // Check for --option=value format
    const eqIndex = option.indexOf('=')
    if (eqIndex !== -1) {
      name = option.slice(0, eqIndex)
      value = option.slice(eqIndex + 1)
    }

    const optDef = this.findOption(name)
    if (!optDef) {
      // Unknown option, store as-is
      this.optionValues[name] = value ?? true
      return
    }

    if (optDef.requiresValue) {
      if (value === undefined) {
        // Value is next argument
        value = argv[index + 1]
      }
      if (optDef.array) {
        const arr = this.optionValues[optDef.name] as string[]
        arr.push(value ?? '')
      } else {
        this.optionValues[optDef.name] = value ?? ''
      }
    } else {
      // Boolean flag
      this.optionValues[optDef.name] = true
    }
  }

  /**
   * Parse a short option.
   */
  protected parseShortOption(option: string, argv: string[], index: number): void {
    const optDef = this.findOptionByShortcut(option)
    if (!optDef) {
      // Unknown option, store as boolean
      this.optionValues[option] = true
      return
    }

    if (optDef.requiresValue) {
      const value = argv[index + 1]
      if (optDef.array) {
        const arr = this.optionValues[optDef.name] as string[]
        arr.push(value ?? '')
      } else {
        this.optionValues[optDef.name] = value ?? ''
      }
    } else {
      this.optionValues[optDef.name] = true
    }
  }

  /**
   * Map positional arguments to definitions.
   */
  protected mapArguments(args: string[]): void {
    const argDefs = this.parsed.arguments
    let argIndex = 0

    for (const def of argDefs) {
      if (def.array) {
        // Consume all remaining args
        this.argumentValues[def.name] = args.slice(argIndex)
        break
      } else if (argIndex < args.length) {
        this.argumentValues[def.name] = args[argIndex]
        argIndex++
      } else if (def.defaultValue !== undefined) {
        this.argumentValues[def.name] = def.defaultValue
      } else if (!def.required) {
        this.argumentValues[def.name] = ''
      }
    }
  }

  /**
   * Find an option definition by name.
   */
  protected findOption(name: string): OptionDefinition | undefined {
    return this.parsed.options.find((o) => o.name === name)
  }

  /**
   * Find an option definition by shortcut.
   */
  protected findOptionByShortcut(shortcut: string): OptionDefinition | undefined {
    return this.parsed.options.find((o) => o.shortcut === shortcut)
  }

  /**
   * Check if an option requires a value.
   */
  protected optionRequiresValue(name: string): boolean {
    const opt = this.findOption(name)
    return opt?.requiresValue ?? false
  }

  /**
   * Get an argument value.
   */
  argument<T = string>(name: string): T {
    return this.argumentValues[name] as T
  }

  /**
   * Get all argument values.
   */
  arguments(): Record<string, string | string[]> {
    return { ...this.argumentValues }
  }

  /**
   * Get an option value.
   */
  option<T = string | boolean>(name: string): T | undefined {
    return this.optionValues[name] as T | undefined
  }

  /**
   * Get all option values.
   */
  options(): Record<string, string | boolean | string[]> {
    return { ...this.optionValues }
  }

  /**
   * Check if an option was provided.
   */
  hasOption(name: string): boolean {
    const value = this.optionValues[name]
    if (typeof value === 'boolean') {
      return value
    }
    return value !== undefined && value !== ''
  }

  /**
   * Get the parsed signature.
   */
  getSignature(): ParsedSignature {
    return this.parsed
  }

  /**
   * Get the command name.
   */
  getCommandName(): string {
    return this.parsed.name
  }
}
