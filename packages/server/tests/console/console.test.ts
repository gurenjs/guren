import { describe, test, expect, beforeEach } from 'bun:test'
import {
  Command,
  Input,
  Output,
  BufferedOutput,
  ConsoleKernel,
  createConsoleKernel,
  parseSignature,
} from '../../src/console'

describe('parseSignature', () => {
  test('parses command name', () => {
    const result = parseSignature('users:create')
    expect(result.name).toBe('users:create')
    expect(result.arguments).toHaveLength(0)
    expect(result.options).toHaveLength(0)
  })

  test('parses required argument', () => {
    const result = parseSignature('users:create {name}')
    expect(result.arguments).toHaveLength(1)
    expect(result.arguments[0].name).toBe('name')
    expect(result.arguments[0].required).toBe(true)
    expect(result.arguments[0].array).toBe(false)
  })

  test('parses optional argument', () => {
    const result = parseSignature('users:create {name?}')
    expect(result.arguments[0].name).toBe('name')
    expect(result.arguments[0].required).toBe(false)
  })

  test('parses argument with default value', () => {
    const result = parseSignature('users:create {role=user}')
    expect(result.arguments[0].name).toBe('role')
    expect(result.arguments[0].required).toBe(false)
    expect(result.arguments[0].defaultValue).toBe('user')
  })

  test('parses array argument', () => {
    const result = parseSignature('send:email {emails*}')
    expect(result.arguments[0].name).toBe('emails')
    expect(result.arguments[0].array).toBe(true)
  })

  test('parses boolean option', () => {
    const result = parseSignature('users:create {--admin}')
    expect(result.options).toHaveLength(1)
    expect(result.options[0].name).toBe('admin')
    expect(result.options[0].requiresValue).toBe(false)
    expect(result.options[0].defaultValue).toBe(false)
  })

  test('parses option with required value', () => {
    const result = parseSignature('users:create {--role=}')
    expect(result.options[0].name).toBe('role')
    expect(result.options[0].requiresValue).toBe(true)
  })

  test('parses option with default value', () => {
    const result = parseSignature('users:create {--role=user}')
    expect(result.options[0].name).toBe('role')
    expect(result.options[0].requiresValue).toBe(true)
    expect(result.options[0].defaultValue).toBe('user')
  })

  test('parses option with shortcut', () => {
    const result = parseSignature('users:create {-a|--admin}')
    expect(result.options[0].name).toBe('admin')
    expect(result.options[0].shortcut).toBe('a')
  })

  test('parses array option', () => {
    const result = parseSignature('users:create {--tag=*}')
    expect(result.options[0].name).toBe('tag')
    expect(result.options[0].array).toBe(true)
    expect(result.options[0].requiresValue).toBe(true)
  })

  test('parses complex signature', () => {
    const result = parseSignature('mail:send {to} {--subject=} {-q|--queue} {--cc=*}')
    expect(result.name).toBe('mail:send')
    expect(result.arguments).toHaveLength(1)
    expect(result.arguments[0].name).toBe('to')
    expect(result.options).toHaveLength(3)
    expect(result.options[0].name).toBe('subject')
    expect(result.options[1].name).toBe('queue')
    expect(result.options[1].shortcut).toBe('q')
    expect(result.options[2].name).toBe('cc')
    expect(result.options[2].array).toBe(true)
  })

  test('parses argument description containing spaces', () => {
    const result = parseSignature('reports:digest {email : The recipient address}')
    expect(result.arguments).toHaveLength(1)
    expect(result.arguments[0].name).toBe('email')
    expect(result.arguments[0].description).toBe('The recipient address')
    expect(result.arguments[0].required).toBe(true)
  })

  test('parses option description containing spaces', () => {
    const result = parseSignature('reports:digest {--dry-run : Do not send anything}')
    expect(result.options).toHaveLength(1)
    expect(result.options[0].name).toBe('dry-run')
    expect(result.options[0].description).toBe('Do not send anything')
    expect(result.options[0].requiresValue).toBe(false)
  })

  test('parses description with whitespace on only one side of the colon', () => {
    const trailing = parseSignature('reports:digest {email: The recipient}')
    expect(trailing.arguments[0].name).toBe('email')
    expect(trailing.arguments[0].description).toBe('The recipient')

    const leading = parseSignature('reports:digest {email :Recipient}')
    expect(leading.arguments[0].name).toBe('email')
    expect(leading.arguments[0].description).toBe('Recipient')
  })

  test('parses one-sided separator on a token carrying a marker', () => {
    const optional = parseSignature('reports:digest {name?: Display name}')
    expect(optional.arguments[0].name).toBe('name')
    expect(optional.arguments[0].required).toBe(false)
    expect(optional.arguments[0].description).toBe('Display name')

    const defaulted = parseSignature('reports:digest {role=user: The assigned role}')
    expect(defaulted.arguments[0].name).toBe('role')
    expect(defaulted.arguments[0].defaultValue).toBe('user')
    expect(defaulted.arguments[0].description).toBe('The assigned role')
  })

  test('parses argument default value with description', () => {
    const result = parseSignature('reports:digest {role=user : The role to assign}')
    expect(result.arguments[0].name).toBe('role')
    expect(result.arguments[0].defaultValue).toBe('user')
    expect(result.arguments[0].required).toBe(false)
    expect(result.arguments[0].description).toBe('The role to assign')
  })

  test('parses array argument with description', () => {
    const result = parseSignature('send:email {emails* : One or more addresses}')
    expect(result.arguments[0].name).toBe('emails')
    expect(result.arguments[0].array).toBe(true)
    expect(result.arguments[0].description).toBe('One or more addresses')
  })

  test('parses option default value with description', () => {
    const result = parseSignature('users:create {--role=user : The role to assign}')
    expect(result.options[0].name).toBe('role')
    expect(result.options[0].defaultValue).toBe('user')
    expect(result.options[0].requiresValue).toBe(true)
    expect(result.options[0].description).toBe('The role to assign')
  })

  test('parses array option with description', () => {
    const result = parseSignature('users:create {--tag=* : Tags to attach}')
    expect(result.options[0].name).toBe('tag')
    expect(result.options[0].array).toBe(true)
    expect(result.options[0].requiresValue).toBe(true)
    expect(result.options[0].description).toBe('Tags to attach')
  })

  test('parses option shortcut with description', () => {
    const result = parseSignature('mail:send {-q|--queue : Push onto the queue}')
    expect(result.options[0].name).toBe('queue')
    expect(result.options[0].shortcut).toBe('q')
    expect(result.options[0].description).toBe('Push onto the queue')
  })

  test('parses value-requiring option with description', () => {
    const result = parseSignature('mail:send {--subject= : Subject line}')
    expect(result.options[0].name).toBe('subject')
    expect(result.options[0].requiresValue).toBe(true)
    expect(result.options[0].defaultValue).toBeUndefined()
    expect(result.options[0].description).toBe('Subject line')
  })

  test('parses a signature spread over multiple lines', () => {
    const result = parseSignature(`reports:digest
      {email : The recipient address}
      {--dry-run : Skip delivery}`)

    expect(result.name).toBe('reports:digest')
    expect(result.arguments).toHaveLength(1)
    expect(result.arguments[0].name).toBe('email')
    expect(result.arguments[0].description).toBe('The recipient address')
    expect(result.options).toHaveLength(1)
    expect(result.options[0].name).toBe('dry-run')
    expect(result.options[0].description).toBe('Skip delivery')
  })

  test('keeps colons inside default values out of descriptions', () => {
    const result = parseSignature('site:ping {--url=https://example.com}')
    expect(result.options[0].name).toBe('url')
    expect(result.options[0].defaultValue).toBe('https://example.com')
    expect(result.options[0].description).toBeUndefined()
  })

  test('parses multiple described tokens in one signature', () => {
    const result = parseSignature(
      'reports:digest {email : The recipient address} {period? : Reporting period} {--dry-run : Skip delivery} {--limit=10 : Maximum rows}'
    )

    expect(result.name).toBe('reports:digest')
    expect(result.arguments).toHaveLength(2)
    expect(result.arguments[0].name).toBe('email')
    expect(result.arguments[0].description).toBe('The recipient address')
    expect(result.arguments[1].name).toBe('period')
    expect(result.arguments[1].required).toBe(false)
    expect(result.arguments[1].description).toBe('Reporting period')

    expect(result.options).toHaveLength(2)
    expect(result.options[0].name).toBe('dry-run')
    expect(result.options[0].description).toBe('Skip delivery')
    expect(result.options[1].name).toBe('limit')
    expect(result.options[1].defaultValue).toBe('10')
    expect(result.options[1].description).toBe('Maximum rows')
  })
})

describe('Input', () => {
  test('parses positional arguments', () => {
    const input = new Input('users:create {name}', ['John'])
    expect(input.argument<string>('name')).toBe('John')
  })

  test('parses multiple arguments', () => {
    const input = new Input('users:create {first} {last}', ['John', 'Doe'])
    expect(input.argument<string>('first')).toBe('John')
    expect(input.argument<string>('last')).toBe('Doe')
  })

  test('uses default argument value', () => {
    const input = new Input('users:create {role=user}', [])
    expect(input.argument<string>('role')).toBe('user')
  })

  test('parses array argument', () => {
    const input = new Input('send:email {emails*}', ['a@test.com', 'b@test.com'])
    expect(input.argument<string[]>('emails')).toEqual(['a@test.com', 'b@test.com'])
  })

  test('parses boolean option (flag)', () => {
    const input = new Input('users:create {--admin}', ['--admin'])
    expect(input.option<boolean>('admin')).toBe(true)
  })

  test('returns false for unprovided boolean option', () => {
    const input = new Input('users:create {--admin}', [])
    expect(input.option<boolean>('admin')).toBe(false)
  })

  test('parses option with value', () => {
    const input = new Input('users:create {--role=}', ['--role=admin'])
    expect(input.option<string>('role')).toBe('admin')
  })

  test('parses option with value (space separated)', () => {
    const input = new Input('users:create {--role=}', ['--role', 'admin'])
    expect(input.option<string>('role')).toBe('admin')
  })

  test('uses default option value', () => {
    const input = new Input('users:create {--role=user}', [])
    expect(input.option<string>('role')).toBe('user')
  })

  test('resolves values for tokens carrying a description', () => {
    const input = new Input(
      'reports:digest {email : The recipient address} {--dry-run : Skip delivery} {--limit=10 : Maximum rows}',
      ['ops@example.com', '--dry-run', '--limit', '25']
    )

    expect(input.argument<string>('email')).toBe('ops@example.com')
    expect(input.option<boolean>('dry-run')).toBe(true)
    expect(input.option<string>('limit')).toBe('25')
  })

  test('parses short option', () => {
    const input = new Input('users:create {-a|--admin}', ['-a'])
    expect(input.option<boolean>('admin')).toBe(true)
  })

  test('parses array option', () => {
    const input = new Input('users:create {--tag=*}', ['--tag', 'foo', '--tag', 'bar'])
    expect(input.option<string[]>('tag')).toEqual(['foo', 'bar'])
  })

  test('hasOption returns true for provided option', () => {
    const input = new Input('users:create {--admin}', ['--admin'])
    expect(input.hasOption('admin')).toBe(true)
  })

  test('hasOption returns false for unprovided option', () => {
    const input = new Input('users:create {--admin}', [])
    expect(input.hasOption('admin')).toBe(false)
  })

  test('arguments() returns all arguments', () => {
    const input = new Input('users:create {first} {last}', ['John', 'Doe'])
    expect(input.arguments()).toEqual({ first: 'John', last: 'Doe' })
  })

  test('options() returns all options', () => {
    const input = new Input('users:create {--admin} {--role=user}', ['--admin', '--role', 'moderator'])
    const opts = input.options()
    expect(opts.admin).toBe(true)
    expect(opts.role).toBe('moderator')
  })

  test('getCommandName returns command name', () => {
    const input = new Input('users:create {name}', ['John'])
    expect(input.getCommandName()).toBe('users:create')
  })

  test('mixed arguments and options', () => {
    const input = new Input('mail:send {to} {--subject=} {--urgent}', [
      'john@test.com',
      '--subject',
      'Hello',
      '--urgent',
    ])
    expect(input.argument<string>('to')).toBe('john@test.com')
    expect(input.option<string>('subject')).toBe('Hello')
    expect(input.option<boolean>('urgent')).toBe(true)
  })
})

describe('Output', () => {
  test('creates output instance', () => {
    const output = new Output({ colors: false })
    expect(output).toBeInstanceOf(Output)
  })

  test('isColored returns color setting', () => {
    const output = new Output({ colors: true })
    expect(output.isColored()).toBe(true)

    const noColor = new Output({ colors: false })
    expect(noColor.isColored()).toBe(false)
  })

  test('setColors changes color setting', () => {
    const output = new Output({ colors: false })
    output.setColors(true)
    expect(output.isColored()).toBe(true)
  })

  test('progressBar generates progress string', () => {
    const output = new Output({ colors: false })
    const bar = output.progressBar(50, 100, 10)
    expect(bar).toContain('50%')
    expect(bar).toContain('█████')
  })

  test('progressBar handles edge cases', () => {
    const output = new Output({ colors: false })
    expect(output.progressBar(0, 100, 10)).toContain('0%')
    expect(output.progressBar(100, 100, 10)).toContain('100%')
  })
})

describe('BufferedOutput', () => {
  test('collects output', () => {
    const output = new BufferedOutput()
    output.info('Processing')
    output.success('Done')
    expect(output.getLines()).toHaveLength(2)
  })

  test('getOutput returns joined output', () => {
    const output = new BufferedOutput()
    output.line('Line 1')
    output.line('Line 2')
    expect(output.getOutput()).toContain('Line 1')
    expect(output.getOutput()).toContain('Line 2')
  })

  test('contains checks for substring', () => {
    const output = new BufferedOutput()
    output.info('User created')
    expect(output.contains('User')).toBe(true)
    expect(output.contains('Deleted')).toBe(false)
  })

  test('clear empties buffer', () => {
    const output = new BufferedOutput()
    output.info('Test')
    expect(output.getLines()).toHaveLength(1)
    output.clear()
    expect(output.getLines()).toHaveLength(0)
  })

  test('table outputs formatted table', () => {
    const output = new BufferedOutput()
    output.table(['Name', 'Age'], [['John', '30'], ['Jane', '25']])
    const result = output.getOutput()
    expect(result).toContain('Name')
    expect(result).toContain('Age')
    expect(result).toContain('John')
    expect(result).toContain('30')
  })

  test('newLine adds empty lines', () => {
    const output = new BufferedOutput()
    output.line('Start')
    output.newLine(2)
    output.line('End')
    expect(output.getLines()).toHaveLength(4)
  })
})

class TestCommand extends Command {
  static signature = 'test:run {name} {--force}'
  static description = 'A test command'

  async handle(): Promise<number> {
    const name = this.argument('name')
    const force = this.hasOption('force')

    this.info(`Running test: ${name}`)
    if (force) {
      this.warn('Force mode enabled')
    }
    this.success('Test completed')

    return 0
  }
}

class FailingCommand extends Command {
  static signature = 'test:fail'
  static description = 'A failing command'

  async handle(): Promise<number> {
    throw new Error('Command failed')
  }
}

class ReturnCodeCommand extends Command {
  static signature = 'test:code {code}'
  static description = 'Returns specified exit code'

  async handle(): Promise<number> {
    return parseInt(this.argument('code'), 10)
  }
}

describe('Command', () => {
  let output: BufferedOutput

  beforeEach(() => {
    output = new BufferedOutput()
  })

  test('runs command successfully', async () => {
    const command = new TestCommand()
    command.setInput(['TestName'])
    command.setOutput(output)

    const result = await command.run()

    expect(result).toBe(0)
    expect(output.contains('Running test: TestName')).toBe(true)
    expect(output.contains('Test completed')).toBe(true)
  })

  test('handles command with options', async () => {
    const command = new TestCommand()
    command.setInput(['TestName', '--force'])
    command.setOutput(output)

    await command.run()

    expect(output.contains('Force mode enabled')).toBe(true)
  })

  test('returns error code on failure', async () => {
    const command = new FailingCommand()
    command.setInput([])
    command.setOutput(output)

    const result = await command.run()

    expect(result).toBe(1)
    expect(output.contains('Command failed')).toBe(true)
  })

  test('returns custom exit code', async () => {
    const command = new ReturnCodeCommand()
    command.setInput(['42'])
    command.setOutput(output)

    const result = await command.run()

    expect(result).toBe(42)
  })

  test('getSignature returns command signature', () => {
    const command = new TestCommand()
    expect(command.getSignature()).toBe('test:run {name} {--force}')
  })

  test('getDescription returns command description', () => {
    const command = new TestCommand()
    expect(command.getDescription()).toBe('A test command')
  })

  test('arguments returns all arguments', () => {
    const command = new TestCommand()
    command.setInput(['TestValue'])
    command.setOutput(output)

    expect(command.arguments()).toEqual({ name: 'TestValue' })
  })

  test('options returns all options', () => {
    const command = new TestCommand()
    command.setInput(['TestValue', '--force'])
    command.setOutput(output)

    const opts = command.options()
    expect(opts.force).toBe(true)
  })

  test('option with default value', () => {
    class CommandWithDefault extends Command {
      static signature = 'test:default {--level=info}'
      static description = 'Test with default'

      async handle(): Promise<void> {
        this.line(`Level: ${this.option('level', 'debug')}`)
      }
    }

    const command = new CommandWithDefault()
    command.setInput([])
    command.setOutput(output)
    command.run()

    expect(output.contains('Level: info')).toBe(true)
  })

  test('info outputs info message', async () => {
    class InfoCommand extends Command {
      static signature = 'test:info'
      static description = 'Info test'

      async handle(): Promise<void> {
        this.info('Info message')
      }
    }

    const command = new InfoCommand()
    command.setInput([])
    command.setOutput(output)
    await command.run()

    expect(output.contains('INFO')).toBe(true)
    expect(output.contains('Info message')).toBe(true)
  })

  test('error outputs error message', async () => {
    class ErrorCommand extends Command {
      static signature = 'test:error'
      static description = 'Error test'

      async handle(): Promise<void> {
        this.error('Error message')
      }
    }

    const command = new ErrorCommand()
    command.setInput([])
    command.setOutput(output)
    await command.run()

    expect(output.contains('ERROR')).toBe(true)
    expect(output.contains('Error message')).toBe(true)
  })

  test('warn outputs warning message', async () => {
    class WarnCommand extends Command {
      static signature = 'test:warn'
      static description = 'Warn test'

      async handle(): Promise<void> {
        this.warn('Warning message')
      }
    }

    const command = new WarnCommand()
    command.setInput([])
    command.setOutput(output)
    await command.run()

    expect(output.contains('WARN')).toBe(true)
    expect(output.contains('Warning message')).toBe(true)
  })

  test('success outputs success message', async () => {
    class SuccessCommand extends Command {
      static signature = 'test:success'
      static description = 'Success test'

      async handle(): Promise<void> {
        this.success('Success message')
      }
    }

    const command = new SuccessCommand()
    command.setInput([])
    command.setOutput(output)
    await command.run()

    expect(output.contains('DONE')).toBe(true)
    expect(output.contains('Success message')).toBe(true)
  })

  test('table outputs formatted table', async () => {
    class TableCommand extends Command {
      static signature = 'test:table'
      static description = 'Table test'

      async handle(): Promise<void> {
        this.table(['Col1', 'Col2'], [['A', 'B'], ['C', 'D']])
      }
    }

    const command = new TableCommand()
    command.setInput([])
    command.setOutput(output)
    await command.run()

    expect(output.contains('Col1')).toBe(true)
    expect(output.contains('Col2')).toBe(true)
    expect(output.contains('A')).toBe(true)
  })
})

/**
 * The non-blank lines of a help screen, whitespace runs collapsed, so an assertion can pin
 * label-to-description pairing without depending on the column width.
 */
function helpLines(output: BufferedOutput): string[] {
  return output
    .getLines()
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
}

describe('ConsoleKernel', () => {
  let kernel: ConsoleKernel
  let output: BufferedOutput

  beforeEach(() => {
    kernel = new ConsoleKernel()
    output = new BufferedOutput()
    kernel.setOutput(output)
  })

  test('registers command', () => {
    kernel.register(TestCommand)
    expect(kernel.hasCommand('test:run')).toBe(true)
  })

  test('registers multiple commands', () => {
    kernel.registerMany([TestCommand, FailingCommand])
    expect(kernel.hasCommand('test:run')).toBe(true)
    expect(kernel.hasCommand('test:fail')).toBe(true)
  })

  test('getCommands returns all commands', () => {
    kernel.register(TestCommand)
    kernel.register(FailingCommand)
    const commands = kernel.getCommands()
    expect(commands.size).toBe(2)
  })

  test('getCommand returns registered command', () => {
    kernel.register(TestCommand)
    const cmd = kernel.getCommand('test:run')
    expect(cmd).toBe(TestCommand)
  })

  test('getCommand returns undefined for unknown command', () => {
    expect(kernel.getCommand('unknown')).toBeUndefined()
  })

  test('handles command execution', async () => {
    kernel.register(TestCommand)
    const result = await kernel.handle(['test:run', 'MyTest'])

    expect(result).toBe(0)
    expect(output.contains('Running test: MyTest')).toBe(true)
  })

  test('handles command with options', async () => {
    kernel.register(TestCommand)
    const result = await kernel.handle(['test:run', 'MyTest', '--force'])

    expect(result).toBe(0)
    expect(output.contains('Force mode enabled')).toBe(true)
  })

  test('returns error for unknown command', async () => {
    const result = await kernel.handle(['unknown:command'])

    expect(result).toBe(1)
    expect(output.contains('Command not found')).toBe(true)
  })

  test('shows help with no command', async () => {
    kernel.register(TestCommand)
    const result = await kernel.handle([])

    expect(result).toBe(0)
    expect(output.contains('Available Commands')).toBe(true)
  })

  test('shows help with --help flag', async () => {
    kernel.register(TestCommand)
    const result = await kernel.handle(['--help'])

    expect(result).toBe(0)
    expect(output.contains('Available Commands')).toBe(true)
  })

  test('shows command help', async () => {
    kernel.register(TestCommand)
    const result = await kernel.handle(['help', 'test:run'])

    expect(result).toBe(0)
    expect(output.contains('A test command')).toBe(true)
    expect(output.contains('Usage:')).toBe(true)
  })

  test('shows command help with argument and option descriptions', async () => {
    class DescribedCommand extends Command {
      static signature =
        'reports:digest {email : The recipient address} {period? : Reporting period} {--dry-run : Skip delivery} {--limit=10 : Maximum rows}'
      static description = 'Send the digest report'

      async handle(): Promise<void> {}
    }

    kernel.register(DescribedCommand)
    const result = await kernel.handle(['help', 'reports:digest'])

    expect(result).toBe(0)
    expect(helpLines(output)).toEqual([
      'INFO Command: reports:digest',
      'Send the digest report',
      'Usage: reports:digest [options] <email> [period]',
      'Arguments:',
      'email The recipient address (required)',
      'period Reporting period (optional)',
      'Options:',
      '--dry-run Skip delivery',
      '--limit=<value> Maximum rows [default: 10]',
    ])
  })

  test('shows whether an option takes a value or repeats', async () => {
    class ArityCommand extends Command {
      static signature =
        'mail:send {emails* : Recipients} {--subject= : Subject line} {--tag=* : Tags to attach} {--dry-run : Skip delivery}'
      static description = 'Send mail'

      async handle(): Promise<void> {}
    }

    kernel.register(ArityCommand)
    const result = await kernel.handle(['help', 'mail:send'])

    expect(result).toBe(0)
    expect(helpLines(output)).toEqual([
      'INFO Command: mail:send',
      'Send mail',
      'Usage: mail:send [options] <emails...>',
      'Arguments:',
      'emails... Recipients (required)',
      'Options:',
      '--subject=<value> Subject line',
      '--tag=<value>... Tags to attach',
      '--dry-run Skip delivery',
    ])
  })

  test('aligns help descriptions past the longest label', async () => {
    class WideCommand extends Command {
      static signature =
        'queue:work {--connection= : Connection name} {--max-attempts=3 : Retries} {-t|--attachment=* : Files to attach} {--dry-run : Skip}'
      static description = 'Process queued jobs'

      async handle(): Promise<void> {}
    }

    kernel.register(WideCommand)
    await kernel.handle(['help', 'queue:work'])

    // Descriptions start two columns past the longest label, not at a fixed column.
    const rows = output.getLines().filter((line) => line.includes('--'))
    expect(rows).toEqual([
      '      --connection=<value>     Connection name',
      '      --max-attempts=<value>   Retries [default: 3]',
      '  -t, --attachment=<value>...  Files to attach',
      '      --dry-run                Skip',
    ])
  })

  test('lists commands', async () => {
    kernel.register(TestCommand)
    kernel.register(FailingCommand)
    const result = await kernel.handle(['list'])

    expect(result).toBe(0)
    expect(output.contains('test:run')).toBe(true)
    expect(output.contains('test:fail')).toBe(true)
  })

  test('call executes command programmatically', async () => {
    kernel.register(TestCommand)
    const result = await kernel.call('test:run', ['CallTest'])

    expect(result).toBe(0)
    expect(output.contains('Running test: CallTest')).toBe(true)
  })

  test('call with silent flag suppresses output', async () => {
    kernel.register(TestCommand)
    const result = await kernel.call('test:run', ['SilentTest'], true)

    expect(result).toBe(0)
    expect(output.contains('SilentTest')).toBe(false)
  })

  test('createConsoleKernel creates kernel', () => {
    const k = createConsoleKernel()
    expect(k).toBeInstanceOf(ConsoleKernel)
  })

  test('handles failed command', async () => {
    kernel.register(FailingCommand)
    const result = await kernel.handle(['test:fail'])

    expect(result).toBe(1)
  })

  test('setOutput and getOutput work correctly', () => {
    const newOutput = new BufferedOutput()
    kernel.setOutput(newOutput)
    expect(kernel.getOutput()).toBe(newOutput)
  })
})

describe('Console Integration', () => {
  test('command can call another command', async () => {
    class ParentCommand extends Command {
      static signature = 'parent:run'
      static description = 'Parent command'

      async handle(): Promise<void> {
        this.info('Parent starting')
        await this.call('child:run')
        this.info('Parent done')
      }
    }

    class ChildCommand extends Command {
      static signature = 'child:run'
      static description = 'Child command'

      async handle(): Promise<void> {
        this.info('Child executed')
      }
    }

    const kernel = new ConsoleKernel()
    const output = new BufferedOutput()
    kernel.setOutput(output)
    kernel.register(ParentCommand)
    kernel.register(ChildCommand)

    await kernel.handle(['parent:run'])

    expect(output.contains('Parent starting')).toBe(true)
    expect(output.contains('Child executed')).toBe(true)
    expect(output.contains('Parent done')).toBe(true)
  })

  test('complex command with multiple arguments and options', async () => {
    class ComplexCommand extends Command {
      static signature = 'complex {action} {target?} {--verbose} {--count=1} {--tags=*}'
      static description = 'Complex command'

      async handle(): Promise<void> {
        const action = this.argument('action')
        const target = this.argument('target') || 'default'
        const verbose = this.hasOption('verbose')
        const count = parseInt(this.option('count', '1') as string, 10)
        const tags = this.option<string[]>('tags') || []

        this.line(`Action: ${action}`)
        this.line(`Target: ${target}`)
        this.line(`Verbose: ${verbose}`)
        this.line(`Count: ${count}`)
        this.line(`Tags: ${tags.join(', ')}`)
      }
    }

    const kernel = new ConsoleKernel()
    const output = new BufferedOutput()
    kernel.setOutput(output)
    kernel.register(ComplexCommand)

    await kernel.handle([
      'complex',
      'deploy',
      'production',
      '--verbose',
      '--count',
      '5',
      '--tags',
      'api',
      '--tags',
      'web',
    ])

    expect(output.contains('Action: deploy')).toBe(true)
    expect(output.contains('Target: production')).toBe(true)
    expect(output.contains('Verbose: true')).toBe(true)
    expect(output.contains('Count: 5')).toBe(true)
    expect(output.contains('Tags: api, web')).toBe(true)
  })

  test('command grouping by namespace', async () => {
    class UsersListCommand extends Command {
      static signature = 'users:list'
      static description = 'List users'
      async handle(): Promise<void> {}
    }

    class UsersCreateCommand extends Command {
      static signature = 'users:create'
      static description = 'Create user'
      async handle(): Promise<void> {}
    }

    class CacheClearCommand extends Command {
      static signature = 'cache:clear'
      static description = 'Clear cache'
      async handle(): Promise<void> {}
    }

    const kernel = new ConsoleKernel()
    const output = new BufferedOutput()
    kernel.setOutput(output)
    kernel.register(UsersListCommand)
    kernel.register(UsersCreateCommand)
    kernel.register(CacheClearCommand)

    await kernel.handle([])

    const result = output.getOutput()
    expect(result).toContain('users')
    expect(result).toContain('cache')
  })
})
