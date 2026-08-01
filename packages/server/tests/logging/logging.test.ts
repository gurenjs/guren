import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  Logger,
  LogManager,
  ConsoleChannel,
  FileChannel,
  DailyFileChannel,
  LOG_LEVEL_PRIORITY,
  createLogManager,
  setLogManager,
  getLogManager,
} from '../../src/logging'

describe('LOG_LEVEL_PRIORITY', () => {
  it('has correct priority order', () => {
    expect(LOG_LEVEL_PRIORITY.emergency).toBe(0)
    expect(LOG_LEVEL_PRIORITY.alert).toBe(1)
    expect(LOG_LEVEL_PRIORITY.critical).toBe(2)
    expect(LOG_LEVEL_PRIORITY.error).toBe(3)
    expect(LOG_LEVEL_PRIORITY.warning).toBe(4)
    expect(LOG_LEVEL_PRIORITY.notice).toBe(5)
    expect(LOG_LEVEL_PRIORITY.info).toBe(6)
    expect(LOG_LEVEL_PRIORITY.debug).toBe(7)
  })
})

describe('ConsoleChannel', () => {
  let consoleSpy: MockInstance
  let errorSpy: MockInstance
  let warnSpy: MockInstance
  let infoSpy: MockInstance

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('logs to console.error for error level', () => {
    const channel = new ConsoleChannel({ driver: 'console' })
    channel.log({
      level: 'error',
      message: 'Test error',
      context: {},
      timestamp: new Date(),
    })

    expect(errorSpy).toHaveBeenCalled()
  })

  it('logs to console.warn for warning level', () => {
    const channel = new ConsoleChannel({ driver: 'console' })
    channel.log({
      level: 'warning',
      message: 'Test warning',
      context: {},
      timestamp: new Date(),
    })

    expect(warnSpy).toHaveBeenCalled()
  })

  it('logs to console.info for info level', () => {
    const channel = new ConsoleChannel({ driver: 'console' })
    channel.log({
      level: 'info',
      message: 'Test info',
      context: {},
      timestamp: new Date(),
    })

    expect(infoSpy).toHaveBeenCalled()
  })

  it('logs to console.log for debug level', () => {
    const channel = new ConsoleChannel({ driver: 'console' })
    channel.log({
      level: 'debug',
      message: 'Test debug',
      context: {},
      timestamp: new Date(),
    })

    expect(consoleSpy).toHaveBeenCalled()
  })

  it('respects minimum log level', () => {
    const channel = new ConsoleChannel({ driver: 'console', level: 'warning' })
    channel.log({
      level: 'debug',
      message: 'Should not appear',
      context: {},
      timestamp: new Date(),
    })

    expect(consoleSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('formats as JSON when configured', () => {
    const channel = new ConsoleChannel({
      driver: 'console',
      format: 'json',
      colors: false,
    })
    const timestamp = new Date('2024-01-15T10:30:00Z')

    channel.log({
      level: 'info',
      message: 'Test message',
      context: { userId: 123 },
      timestamp,
    })

    expect(infoSpy).toHaveBeenCalled()
    const output = String(infoSpy.mock.calls[0][0])
    const parsed = JSON.parse(output)
    expect(parsed.timestamp).toBe('2024-01-15T10:30:00.000Z')
    expect(parsed.level).toBe('info')
    expect(parsed.message).toBe('Test message')
    expect(parsed.userId).toBe(123)
  })

  it('includes context in text format', () => {
    const channel = new ConsoleChannel({
      driver: 'console',
      colors: false,
      timestamps: false,
    })

    channel.log({
      level: 'info',
      message: 'Test message',
      context: { userId: 123 },
      timestamp: new Date(),
    })

    const output = String(infoSpy.mock.calls[0][0])
    expect(output).toContain('Test message')
    expect(output).toContain('{"userId":123}')
  })
})

describe('FileChannel', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guren-logging-test-'))
  const testFile = `${testDir}/test.log`

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }
  })

  it('creates log file and directory', () => {
    const channel = new FileChannel({ driver: 'file', path: testFile })
    channel.log({
      level: 'info',
      message: 'Test message',
      context: {},
      timestamp: new Date(),
    })
    channel.close()

    expect(fs.existsSync(testFile)).toBe(true)
  })

  it('appends to existing file', () => {
    const channel = new FileChannel({ driver: 'file', path: testFile })

    channel.log({
      level: 'info',
      message: 'First message',
      context: {},
      timestamp: new Date(),
    })
    channel.log({
      level: 'info',
      message: 'Second message',
      context: {},
      timestamp: new Date(),
    })
    channel.close()

    const content = fs.readFileSync(testFile, 'utf-8')
    expect(content).toContain('First message')
    expect(content).toContain('Second message')
  })

  it('formats as JSON when configured', () => {
    const channel = new FileChannel({
      driver: 'file',
      path: testFile,
      format: 'json',
    })

    channel.log({
      level: 'info',
      message: 'Test message',
      context: { userId: 123 },
      timestamp: new Date('2024-01-15T10:30:00Z'),
    })
    channel.close()

    const content = fs.readFileSync(testFile, 'utf-8')
    const line = content.trim()
    const parsed = JSON.parse(line)
    expect(parsed.level).toBe('info')
    expect(parsed.message).toBe('Test message')
    expect(parsed.userId).toBe(123)
  })

  it('respects minimum log level', () => {
    const channel = new FileChannel({
      driver: 'file',
      path: testFile,
      level: 'error',
    })

    channel.log({
      level: 'debug',
      message: 'Should not appear',
      context: {},
      timestamp: new Date(),
    })
    channel.close()

    expect(fs.existsSync(testFile)).toBe(false)
  })
})

describe('DailyFileChannel', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guren-daily-logging-test-'))
  const testFile = `${testDir}/app.log`

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }
  })

  it('creates dated log file', () => {
    const channel = new DailyFileChannel({ driver: 'daily', path: testFile })
    const date = new Date()
    const dateStr = date.toISOString().split('T')[0]

    channel.log({
      level: 'info',
      message: 'Test message',
      context: {},
      timestamp: date,
    })
    channel.close()

    const expectedFile = `${testDir}/app-${dateStr}.log`
    expect(fs.existsSync(expectedFile)).toBe(true)
  })

  it('rotates when date changes', () => {
    const channel = new DailyFileChannel({ driver: 'daily', path: testFile })

    // Log for yesterday
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    channel.log({
      level: 'info',
      message: 'Yesterday message',
      context: {},
      timestamp: yesterday,
    })

    // Log for today
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]

    channel.log({
      level: 'info',
      message: 'Today message',
      context: {},
      timestamp: today,
    })
    channel.close()

    expect(fs.existsSync(`${testDir}/app-${yesterdayStr}.log`)).toBe(true)
    expect(fs.existsSync(`${testDir}/app-${todayStr}.log`)).toBe(true)
  })

  it('cleans up old files', () => {
    const channel = new DailyFileChannel({
      driver: 'daily',
      path: testFile,
      days: 7,
    })

    // Create old file manually
    fs.mkdirSync(testDir, { recursive: true })
    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 10)
    const oldDateStr = oldDate.toISOString().split('T')[0]
    const oldFile = `${testDir}/app-${oldDateStr}.log`
    fs.writeFileSync(oldFile, 'old content')

    // Log today (triggers cleanup)
    channel.log({
      level: 'info',
      message: 'Test message',
      context: {},
      timestamp: new Date(),
    })
    channel.close()

    // Old file should be deleted
    expect(fs.existsSync(oldFile)).toBe(false)
  })
})

describe('Logger', () => {
  it('logs to all channels', () => {
    const logs: Array<{ level: string; message: string }> = []
    const mockChannel = {
      log: (entry: any) => {
        logs.push({ level: entry.level, message: entry.message })
      },
    }

    const logger = new Logger([mockChannel])
    logger.info('Test message')

    expect(logs).toHaveLength(1)
    expect(logs[0].level).toBe('info')
    expect(logs[0].message).toBe('Test message')
  })

  it('supports all log levels', () => {
    const logs: string[] = []
    const mockChannel = {
      log: (entry: any) => {
        logs.push(entry.level)
      },
    }

    const logger = new Logger([mockChannel])
    logger.emergency('test')
    logger.alert('test')
    logger.critical('test')
    logger.error('test')
    logger.warning('test')
    logger.warn('test') // alias
    logger.notice('test')
    logger.info('test')
    logger.debug('test')

    expect(logs).toEqual([
      'emergency',
      'alert',
      'critical',
      'error',
      'warning',
      'warning', // warn alias
      'notice',
      'info',
      'debug',
    ])
  })

  it('includes context', () => {
    let capturedContext: any
    const mockChannel = {
      log: (entry: any) => {
        capturedContext = entry.context
      },
    }

    const logger = new Logger([mockChannel])
    logger.info('Test', { userId: 123 })

    expect(capturedContext).toEqual({ userId: 123 })
  })

  it('supports withContext', () => {
    let capturedContext: any
    const mockChannel = {
      log: (entry: any) => {
        capturedContext = entry.context
      },
    }

    const logger = new Logger([mockChannel])
    const childLogger = logger.withContext({ requestId: 'abc' })
    childLogger.info('Test', { userId: 123 })

    expect(capturedContext).toEqual({ requestId: 'abc', userId: 123 })
  })

  it('supports child alias', () => {
    let capturedContext: any
    const mockChannel = {
      log: (entry: any) => {
        capturedContext = entry.context
      },
    }

    const logger = new Logger([mockChannel])
    const childLogger = logger.child({ requestId: 'xyz' })
    childLogger.info('Test')

    expect(capturedContext).toEqual({ requestId: 'xyz' })
  })

  it('handles channel errors gracefully', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failingChannel = {
      log: () => {
        throw new Error('Channel error')
      },
    }
    const successChannel = {
      log: vi.fn(),
    }

    const logger = new Logger([failingChannel, successChannel])
    logger.info('Test')

    // Should not throw
    expect(successChannel.log).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('LogManager', () => {
  it('creates console channel', () => {
    const manager = new LogManager({
      default: 'console',
      channels: {
        console: { driver: 'console' },
      },
    })

    const logger = manager.channel()
    expect(logger).toBeInstanceOf(Logger)
  })

  it('uses default channel', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const manager = new LogManager({
      default: 'console',
      channels: {
        console: { driver: 'console' },
      },
    })

    manager.info('Test message')
    expect(consoleSpy).toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('switches channels', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guren-logmanager-test-'))
    const testFile = `${testDir}/test.log`

    const manager = new LogManager({
      default: 'console',
      channels: {
        console: { driver: 'console' },
        file: { driver: 'file', path: testFile },
      },
    })

    manager.channel('file').info('Test message')
    manager.close()

    expect(fs.existsSync(testFile)).toBe(true)
    fs.rmSync(testDir, { recursive: true })
  })

  it('creates stack channel', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const testDir = '/tmp/guren-logmanager-stack-test'
    const testFile = `${testDir}/test.log`

    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }

    const manager = new LogManager({
      default: 'stack',
      channels: {
        console: { driver: 'console' },
        file: { driver: 'file', path: testFile },
        stack: { driver: 'stack', channels: ['console', 'file'] },
      },
    })

    manager.info('Test message')
    manager.close()

    expect(consoleSpy).toHaveBeenCalled()
    expect(fs.existsSync(testFile)).toBe(true)

    consoleSpy.mockRestore()
    fs.rmSync(testDir, { recursive: true })
  })

  it('supports stack method', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const testDir = '/tmp/guren-logmanager-stack-method-test'
    const testFile = `${testDir}/test.log`

    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }

    const manager = new LogManager({
      default: 'console',
      channels: {
        console: { driver: 'console' },
        file: { driver: 'file', path: testFile },
      },
    })

    manager.stack(['console', 'file']).info('Test message')
    manager.close()

    expect(consoleSpy).toHaveBeenCalled()
    expect(fs.existsSync(testFile)).toBe(true)

    consoleSpy.mockRestore()
    fs.rmSync(testDir, { recursive: true })
  })

  it('throws for undefined channel', () => {
    const manager = new LogManager({
      default: 'console',
      channels: {
        console: { driver: 'console' },
      },
    })

    expect(() => manager.channel('unknown')).toThrow('Log channel [unknown] is not defined')
  })

  it('throws for unsupported driver', () => {
    const manager = new LogManager({
      default: 'custom',
      channels: {
        custom: { driver: 'unsupported' },
      },
    })

    expect(() => manager.channel()).toThrow('Log driver [unsupported] is not supported')
  })

  it('supports custom drivers', () => {
    const logs: string[] = []

    const manager = new LogManager({
      default: 'custom',
      channels: {
        custom: { driver: 'custom' },
      },
    })

    manager.registerDriver('custom', () => ({
      log: (entry) => {
        logs.push(entry.message)
      },
    }))

    manager.info('Test message')
    expect(logs).toEqual(['Test message'])
  })

  it('provides convenience methods', () => {
    const logs: Array<{ level: string; message: string }> = []

    const manager = new LogManager({
      default: 'custom',
      channels: {
        custom: { driver: 'custom' },
      },
    })

    manager.registerDriver('custom', () => ({
      log: (entry) => {
        logs.push({ level: entry.level, message: entry.message })
      },
    }))

    manager.emergency('e')
    manager.alert('a')
    manager.critical('c')
    manager.error('er')
    manager.warning('w')
    manager.warn('wa')
    manager.notice('n')
    manager.info('i')
    manager.debug('d')

    expect(logs.map((l) => l.level)).toEqual([
      'emergency',
      'alert',
      'critical',
      'error',
      'warning',
      'warning',
      'notice',
      'info',
      'debug',
    ])
  })

  it('supports withContext', () => {
    let capturedContext: any

    const manager = new LogManager({
      default: 'custom',
      channels: {
        custom: { driver: 'custom' },
      },
    })

    manager.registerDriver('custom', () => ({
      log: (entry) => {
        capturedContext = entry.context
      },
    }))

    manager.withContext({ requestId: 'abc' }).info('Test')
    expect(capturedContext).toEqual({ requestId: 'abc' })
  })

  it('returns channel names', () => {
    const manager = new LogManager({
      default: 'console',
      channels: {
        console: { driver: 'console' },
        file: { driver: 'file', path: '/tmp/test.log' },
      },
    })

    expect(manager.getChannelNames()).toEqual(['console', 'file'])
  })

  it('returns default channel', () => {
    const manager = new LogManager({
      default: 'file',
      channels: {
        console: { driver: 'console' },
        file: { driver: 'file', path: '/tmp/test.log' },
      },
    })

    expect(manager.getDefaultChannel()).toBe('file')
  })
})

describe('createLogManager', () => {
  it('creates a log manager', () => {
    const manager = createLogManager({
      default: 'console',
      channels: {
        console: { driver: 'console' },
      },
    })

    expect(manager).toBeInstanceOf(LogManager)
  })
})

describe('Global log manager', () => {
  it('throws when not initialized', () => {
    expect(() => getLogManager()).toThrow(
      'Log manager has not been initialized. Call setLogManager() first.'
    )
  })

  it('sets and gets global instance', () => {
    const manager = new LogManager({
      default: 'console',
      channels: {
        console: { driver: 'console' },
      },
    })

    setLogManager(manager)
    expect(getLogManager()).toBe(manager)
  })
})
