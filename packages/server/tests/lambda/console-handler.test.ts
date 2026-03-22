import { describe, test, expect } from 'bun:test'

import { createConsoleHandler } from '../../src/lambda'
import { ConsoleKernel } from '../../src/console/ConsoleKernel'
import { Command } from '../../src/console/Command'

class GreetCommand extends Command {
  static signature = 'greet {name}'
  static description = 'Greet a user'

  async handle(): Promise<number> {
    const name = this.argument('name')
    this.info(`Hello, ${name}!`)
    return 0
  }
}

class FailingCommand extends Command {
  static signature = 'fail'
  static description = 'A command that fails'

  async handle(): Promise<number> {
    return 1
  }
}

describe('createConsoleHandler', () => {
  test('should return a function', () => {
    const kernel = new ConsoleKernel()
    const handler = createConsoleHandler(kernel)

    expect(typeof handler).toBe('function')
  })

  test('should execute a registered command', async () => {
    const kernel = new ConsoleKernel()
    kernel.register(GreetCommand)

    const handler = createConsoleHandler(kernel)
    const result = await handler({ command: 'greet World' })

    expect(result.exitCode).toBe(0)
  })

  test('should return exit code from command', async () => {
    const kernel = new ConsoleKernel()
    kernel.register(FailingCommand)

    const handler = createConsoleHandler(kernel)
    const result = await handler({ command: 'fail' })

    expect(result.exitCode).toBe(1)
  })

  test('should return exit code 1 for unknown commands', async () => {
    const kernel = new ConsoleKernel()

    const handler = createConsoleHandler(kernel)
    const result = await handler({ command: 'nonexistent' })

    expect(result.exitCode).toBe(1)
  })
})
