import type { OutputInterface } from './types'

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
} as const

function supportsColor(): boolean {
  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== '0'
  }
  if (process.env.NO_COLOR !== undefined) {
    return false
  }
  return process.stdout?.isTTY ?? false
}

export class Output implements OutputInterface {
  protected useColors: boolean

  protected stdout: NodeJS.WriteStream

  protected stderr: NodeJS.WriteStream

  constructor(options: { colors?: boolean; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {}) {
    this.useColors = options.colors ?? supportsColor()
    this.stdout = options.stdout ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
  }

  stream(): NodeJS.WriteStream {
    return this.stdout
  }

  protected color(text: string, ...codes: string[]): string {
    if (!this.useColors) {
      return text
    }
    return codes.join('') + text + COLORS.reset
  }

  info(message: string): void {
    this.writeLine(this.color(`INFO  ${message}`, COLORS.blue))
  }

  error(message: string): void {
    this.writeErrorLine(this.color(`ERROR  ${message}`, COLORS.red))
  }

  warn(message: string): void {
    this.writeLine(this.color(`WARN  ${message}`, COLORS.yellow))
  }

  success(message: string): void {
    this.writeLine(this.color(`DONE  ${message}`, COLORS.green))
  }

  line(message: string): void {
    this.writeLine(message)
  }

  newLine(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.writeLine('')
    }
  }

  table(headers: string[], rows: string[][]): void {
    if (headers.length === 0 && rows.length === 0) {
      return
    }

    const columnWidths: number[] = headers.map((h) => h.length)
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const cellWidth = (row[i] ?? '').length
        columnWidths[i] = Math.max(columnWidths[i] ?? 0, cellWidth)
      }
    }

    const separator = '+' + columnWidths.map((w) => '-'.repeat(w + 2)).join('+') + '+'

    this.writeLine(separator)
    const headerRow = '| ' + headers.map((h, i) => h.padEnd(columnWidths[i])).join(' | ') + ' |'
    this.writeLine(this.color(headerRow, COLORS.bold))
    this.writeLine(separator)

    for (const row of rows) {
      const rowStr = '| ' + row.map((cell, i) => (cell ?? '').padEnd(columnWidths[i])).join(' | ') + ' |'
      this.writeLine(rowStr)
    }

    this.writeLine(separator)
  }

  /** Write raw text, without a newline. */
  write(message: string): void {
    this.stdout.write(message)
  }

  protected writeLine(message: string): void {
    this.stdout.write(message + '\n')
  }

  protected writeErrorLine(message: string): void {
    this.stderr.write(message + '\n')
  }

  comment(message: string): void {
    this.writeLine(this.color(message, COLORS.dim))
  }

  question(message: string): void {
    this.write(this.color(`? ${message}`, COLORS.cyan))
  }

  listing(items: string[]): void {
    for (const item of items) {
      this.writeLine(`  • ${item}`)
    }
  }

  colored(message: string, color: keyof typeof COLORS): void {
    this.writeLine(this.color(message, COLORS[color]))
  }

  progressBar(current: number, total: number, width = 30): string {
    const percentage = Math.min(100, Math.max(0, (current / total) * 100))
    const filled = Math.round((percentage / 100) * width)
    const empty = width - filled

    const bar = '█'.repeat(filled) + '░'.repeat(empty)
    const percentStr = percentage.toFixed(0).padStart(3) + '%'

    return `${bar} ${percentStr}`
  }

  clearLine(): void {
    if (this.stdout.isTTY) {
      this.stdout.clearLine(0)
      this.stdout.cursorTo(0)
    }
  }

  isColored(): boolean {
    return this.useColors
  }

  setColors(enabled: boolean): void {
    this.useColors = enabled
  }
}

/** Collects messages instead of printing them, for testing. */
export class BufferedOutput extends Output {
  protected buffer: string[] = []

  constructor() {
    super({ colors: false })
  }

  protected writeLine(message: string): void {
    this.buffer.push(message)
  }

  protected writeErrorLine(message: string): void {
    this.buffer.push(message)
  }

  write(message: string): void {
    if (this.buffer.length > 0) {
      this.buffer[this.buffer.length - 1] += message
    } else {
      this.buffer.push(message)
    }
  }

  getLines(): string[] {
    return [...this.buffer]
  }

  getOutput(): string {
    return this.buffer.join('\n')
  }

  clear(): void {
    this.buffer = []
  }

  contains(text: string): boolean {
    return this.buffer.some((line) => line.includes(text))
  }
}
