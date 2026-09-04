import type {
  ParsedSignature,
  ArgumentDefinition,
  OptionDefinition,
  InputInterface,
} from './types'

/**
 * Parse a command signature: `command:name`, then `{arg}` `{arg?}` `{arg=default}`
 * `{arg*}` (array, must be last) and `{--opt}` `{--opt=}` `{--opt=default}`
 * `{--opt=*}` `{-o|--opt}`, each optionally followed by ` : Description`. The
 * separator needs whitespace on at least one side (keeps colons in defaults out
 * of descriptions); unspaced `{arg:Description}` only on a token with no other marker.
 */
export function parseSignature(signature: string): ParsedSignature {
  const { name, tokens } = tokenizeSignature(signature)
  const args: ArgumentDefinition[] = []
  const options: OptionDefinition[] = []

  for (const token of tokens) {
    const [content, description] = splitSpacedDescription(token)

    if (!content) continue

    if (content.startsWith('-')) {
      options.push(parseOption(content, description))
    } else {
      args.push(parseArgument(content, description))
    }
  }

  return { name, arguments: args, options }
}

/**
 * Tokens are balanced `{...}` groups, so a token may contain whitespace (a
 * description). Unterminated groups are skipped.
 */
function tokenizeSignature(signature: string): { name: string; tokens: string[] } {
  const firstBrace = signature.indexOf('{')
  const head = firstBrace === -1 ? signature : signature.slice(0, firstBrace)
  const name = head.trim().split(/\s+/)[0]

  if (firstBrace === -1) {
    return { name, tokens: [] }
  }

  const tokens: string[] = []
  let depth = 0
  let start = -1

  for (let i = firstBrace; i < signature.length; i++) {
    const char = signature[i]

    if (char === '{') {
      if (depth === 0) start = i
      depth++
    } else if (char === '}' && depth > 0) {
      depth--
      if (depth === 0) {
        tokens.push(signature.slice(start + 1, i))
      }
    }
  }

  return { name, tokens }
}

/** A colon with whitespace on at least one side; see `parseSignature` for why. */
const DESCRIPTION_SEPARATOR = /\s+:\s*|:\s+/

/**
 * Stage one of two, running before the `?` / `*` / `=default` markers are
 * stripped, so a description may contain any of those characters.
 */
function splitSpacedDescription(token: string): [string, string | undefined] {
  const match = DESCRIPTION_SEPARATOR.exec(token)

  if (!match) {
    return [token.trim(), undefined]
  }

  const content = token.slice(0, match.index).trim()
  const description = token.slice(match.index + match[0].length).trim()

  return [content, description || undefined]
}

/**
 * Stage two of two: the unspaced `name:description` form. Runs *after* the
 * markers are stripped, which keeps colons inside a default value out of
 * descriptions, and never overwrites a description stage one already claimed.
 */
function resolveNameAndDescription(
  name: string,
  description?: string
): { name: string; description: string | undefined } {
  if (description === undefined) {
    const colonIndex = name.indexOf(':')
    if (colonIndex !== -1) {
      description = name.slice(colonIndex + 1).trim() || undefined
      name = name.slice(0, colonIndex)
    }
  }

  return { name: name.trim(), description }
}

export function argumentLabel(arg: ArgumentDefinition): string {
  return arg.array ? `${arg.name}...` : arg.name
}

export function optionLabel(opt: OptionDefinition): string {
  if (opt.array) return `--${opt.name}=<value>...`
  if (opt.requiresValue) return `--${opt.name}=<value>`
  return `--${opt.name}`
}

export function formatUsage(parsed: ParsedSignature): string {
  const parts = [parsed.name]

  if (parsed.options.length > 0) {
    parts.push('[options]')
  }

  for (const arg of parsed.arguments) {
    const label = argumentLabel(arg)
    parts.push(arg.required ? `<${label}>` : `[${label}]`)
  }

  return parts.join(' ')
}

function parseArgument(content: string, description?: string): ArgumentDefinition {
  let name = content
  let required = true
  let array = false
  let defaultValue: string | undefined

  if (name.endsWith('*')) {
    array = true
    name = name.slice(0, -1)
  }

  if (name.endsWith('?')) {
    required = false
    name = name.slice(0, -1)
  }

  const eqIndex = name.indexOf('=')
  if (eqIndex !== -1) {
    defaultValue = name.slice(eqIndex + 1)
    name = name.slice(0, eqIndex)
    required = false
  }

  return {
    ...resolveNameAndDescription(name, description),
    required,
    array,
    defaultValue,
  }
}

function parseOption(content: string, description?: string): OptionDefinition {
  let name = content
  let shortcut: string | undefined
  let requiresValue = false
  let defaultValue: string | boolean | undefined
  let array = false

  name = name.replace(/^-+/, '')

  if (name.includes('|')) {
    const [short, long] = name.split('|')
    shortcut = short.replace(/^-*/, '')
    name = long.replace(/^-+/, '')
  }

  if (name.endsWith('=*')) {
    array = true
    requiresValue = true
    name = name.slice(0, -2)
  } else if (name.endsWith('=')) {
    requiresValue = true
    name = name.slice(0, -1)
  } else {
    const eqIndex = name.indexOf('=')
    if (eqIndex !== -1) {
      defaultValue = name.slice(eqIndex + 1)
      name = name.slice(0, eqIndex)
      requiresValue = true
    }
  }

  if (!requiresValue && defaultValue === undefined) {
    defaultValue = false
  }

  return {
    ...resolveNameAndDescription(name, description),
    shortcut,
    requiresValue,
    defaultValue,
    array,
  }
}

export class Input implements InputInterface {
  protected parsed: ParsedSignature

  protected argumentValues: Record<string, string | string[]> = {}

  protected optionValues: Record<string, string | boolean | string[]> = {}

  constructor(signature: string, argv: string[] = []) {
    this.parsed = parseSignature(signature)
    this.parseArgv(argv)
  }

  protected parseArgv(argv: string[]): void {
    const args: string[] = []
    let i = 0

    for (const opt of this.parsed.options) {
      if (opt.defaultValue !== undefined) {
        this.optionValues[opt.name] = opt.defaultValue
      }
    }

    for (const opt of this.parsed.options) {
      if (opt.array) {
        this.optionValues[opt.name] = []
      }
    }

    while (i < argv.length) {
      const arg = argv[i]

      if (arg.startsWith('--')) {
        this.parseLongOption(arg.slice(2), argv, i)
        if (arg.includes('=') || !this.optionRequiresValue(arg.slice(2).split('=')[0])) {
          i++
        } else {
          i += 2 // Skip option and its value
        }
      } else if (arg.startsWith('-') && arg.length > 1) {
        this.parseShortOption(arg.slice(1), argv, i)
        const shortName = arg.slice(1)
        const optDef = this.findOptionByShortcut(shortName)
        if (optDef?.requiresValue && !arg.includes('=')) {
          i += 2
        } else {
          i++
        }
      } else {
        args.push(arg)
        i++
      }
    }

    this.mapArguments(args)
  }

  protected parseLongOption(option: string, argv: string[], index: number): void {
    let name = option
    let value: string | undefined

    const eqIndex = option.indexOf('=')
    if (eqIndex !== -1) {
      name = option.slice(0, eqIndex)
      value = option.slice(eqIndex + 1)
    }

    const optDef = this.findOption(name)
    if (!optDef) {
      this.optionValues[name] = value ?? true
      return
    }

    if (optDef.requiresValue) {
      if (value === undefined) {
        value = argv[index + 1]
      }
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

  protected parseShortOption(option: string, argv: string[], index: number): void {
    const optDef = this.findOptionByShortcut(option)
    if (!optDef) {
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

  protected mapArguments(args: string[]): void {
    const argDefs = this.parsed.arguments
    let argIndex = 0

    for (const def of argDefs) {
      if (def.array) {
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

  protected findOption(name: string): OptionDefinition | undefined {
    return this.parsed.options.find((o) => o.name === name)
  }

  protected findOptionByShortcut(shortcut: string): OptionDefinition | undefined {
    return this.parsed.options.find((o) => o.shortcut === shortcut)
  }

  protected optionRequiresValue(name: string): boolean {
    const opt = this.findOption(name)
    return opt?.requiresValue ?? false
  }

  argument<T = string>(name: string): T {
    return this.argumentValues[name] as T
  }

  arguments(): Record<string, string | string[]> {
    return { ...this.argumentValues }
  }

  option<T = string | boolean>(name: string): T | undefined {
    return this.optionValues[name] as T | undefined
  }

  options(): Record<string, string | boolean | string[]> {
    return { ...this.optionValues }
  }

  hasOption(name: string): boolean {
    const value = this.optionValues[name]
    if (typeof value === 'boolean') {
      return value
    }
    return value !== undefined && value !== ''
  }

  getSignature(): ParsedSignature {
    return this.parsed
  }

  getCommandName(): string {
    return this.parsed.name
  }
}
