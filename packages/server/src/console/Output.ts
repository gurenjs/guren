import type { OutputInterface } from './types'

/**
 * ANSI color codes.
 */
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
} as const

/**
 * Check if output supports colors.
 */
function supportsColor(): boolean {
  // Check for common environment variables
  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== '0'
  }
  if (process.env.NO_COLOR !== undefined) {
    return false
  }
  // Check if stdout is a TTY
  return process.stdout?.isTTY ?? false
}

/**
 * Console output handler.
 *
 * @example
 * ```typescript
 * const output = new Output()
 * output.info('Processing...')
 * output.success('Done!')
 * output.table(['Name', 'Age'], [['John', '30'], ['Jane', '25']])
 * ```
 */
export class Output implements OutputInterface {
  /**
   * Whether to use colors.
   */
  protected useColors: boolean

  /**
   * Output stream.
   */
  protected stdout: NodeJS.WriteStream

  /**
   * Error stream.
   */
  protected stderr: NodeJS.WriteStream

  constructor(options: { colors?: boolean; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {}) {
    this.useColors = options.colors ?? supportsColor()
    this.stdout = options.stdout ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
  }

  /**
   * Apply color to text.
   */
  protected color(text: string, ...codes: string[]): string {
    if (!this.useColors) {
      return text
    }
    return codes.join('') + text + COLORS.reset
  }

  /**
   * Output an info message.
   */
  info(message: string): void {
    this.writeLine(this.color(`INFO  ${message}`, COLORS.blue))
  }

  /**
   * Output an error message.
   */
  error(message: string): void {
    this.writeErrorLine(this.color(`ERROR  ${message}`, COLORS.red))
  }

  /**
   * Output a warning message.
   */
  warn(message: string): void {
    this.writeLine(this.color(`WARN  ${message}`, COLORS.yellow))
  }

  /**
   * Output a success message.
   */
  success(message: string): void {
    this.writeLine(this.color(`DONE  ${message}`, COLORS.green))
  }

  /**
   * Output a plain line.
   */
  line(message: string): void {
    this.writeLine(message)
  }

  /**
   * Output new lines.
   */
  newLine(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.writeLine('')
    }
  }

  /**
   * Output a table.
   */
  table(headers: string[], rows: string[][]): void {
    if (headers.length === 0 && rows.length === 0) {
      return
    }

    // Calculate column widths
    const columnWidths: number[] = headers.map((h) => h.length)
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const cellWidth = (row[i] ?? '').length
        columnWidths[i] = Math.max(columnWidths[i] ?? 0, cellWidth)
      }
    }

    // Generate separator line
    const separator = '+' + columnWidths.map((w) => '-'.repeat(w + 2)).join('+') + '+'

    // Print header
    this.writeLine(separator)
    const headerRow = '| ' + headers.map((h, i) => h.padEnd(columnWidths[i])).join(' | ') + ' |'
    this.writeLine(this.color(headerRow, COLORS.bold))
    this.writeLine(separator)

    // Print rows
    for (const row of rows) {
      const rowStr = '| ' + row.map((cell, i) => (cell ?? '').padEnd(columnWidths[i])).join(' | ') + ' |'
      this.writeLine(rowStr)
    }

    this.writeLine(separator)
  }

  /**
   * Write raw text without newline.
   */
  write(message: string): void {
    this.stdout.write(message)
  }

  /**
   * Write a line to stdout.
   */
  protected writeLine(message: string): void {
    this.stdout.write(message + '\n')
  }

  /**
   * Write a line to stderr.
   */
  protected writeErrorLine(message: string): void {
    this.stderr.write(message + '\n')
  }

  /**
   * Output a comment.
   */
  comment(message: string): void {
    this.writeLine(this.color(message, COLORS.dim))
  }

  /**
   * Output a question.
   */
  question(message: string): void {
    this.write(this.color(`? ${message}`, COLORS.cyan))
  }

  /**
   * Output a bulleted list.
   */
  listing(items: string[]): void {
    for (const item of items) {
      this.writeLine(`  • ${item}`)
    }
  }

  /**
   * Output text with specific color.
   */
  colored(message: string, color: keyof typeof COLORS): void {
    this.writeLine(this.color(message, COLORS[color]))
  }

  /**
   * Create a progress bar string.
   */
  progressBar(current: number, total: number, width = 30): string {
    const percentage = Math.min(100, Math.max(0, (current / total) * 100))
    const filled = Math.round((percentage / 100) * width)
    const empty = width - filled

    const bar = '█'.repeat(filled) + '░'.repeat(empty)
    const percentStr = percentage.toFixed(0).padStart(3) + '%'

    return `${bar} ${percentStr}`
  }

  /**
   * Clear the current line.
   */
  clearLine(): void {
    if (this.stdout.isTTY) {
      this.stdout.clearLine(0)
      this.stdout.cursorTo(0)
    }
  }

  /**
   * Check if colors are enabled.
   */
  isColored(): boolean {
    return this.useColors
  }

  /**
   * Enable or disable colors.
   */
  setColors(enabled: boolean): void {
    this.useColors = enabled
  }
}

/**
 * Output that collects messages instead of printing.
 * Useful for testing.
 */
export class BufferedOutput extends Output {
  /**
   * Collected messages.
   */
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
    // Append to last line or create new one
    if (this.buffer.length > 0) {
      this.buffer[this.buffer.length - 1] += message
    } else {
      this.buffer.push(message)
    }
  }

  /**
   * Get all output as array.
   */
  getLines(): string[] {
    return [...this.buffer]
  }

  /**
   * Get all output as string.
   */
  getOutput(): string {
    return this.buffer.join('\n')
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.buffer = []
  }

  /**
   * Check if buffer contains a string.
   */
  contains(text: string): boolean {
    return this.buffer.some((line) => line.includes(text))
  }
}
