import { describe, test, expect } from 'bun:test'
import { Logger, filterSensitiveData } from './Logger'
import type { LogChannel, LogEntry } from './types'

function createCapture(): { entries: LogEntry[]; channel: LogChannel } {
  const entries: LogEntry[] = []
  return {
    entries,
    channel: {
      log: (entry) => {
        entries.push(entry)
      },
    },
  }
}

describe('filterSensitiveData', () => {
  test('should filter matching keys', () => {
    const data = { username: 'alice', password: 'secret123', email: 'a@b.com' }
    const result = filterSensitiveData(data, ['password'])

    expect(result.username).toBe('alice')
    expect(result.password).toBe('[FILTERED]')
    expect(result.email).toBe('a@b.com')
  })

  test('should be case-insensitive', () => {
    const data = { Password: 'secret', TOKEN: 'abc' }
    const result = filterSensitiveData(data, ['password', 'token'])

    expect(result.Password).toBe('[FILTERED]')
    expect(result.TOKEN).toBe('[FILTERED]')
  })

  test('should filter nested objects', () => {
    const data = {
      user: { name: 'alice', password: 'secret' },
      metadata: { token: 'abc123' },
    }
    const result = filterSensitiveData(data, ['password', 'token']) as any

    expect(result.user.name).toBe('alice')
    expect(result.user.password).toBe('[FILTERED]')
    expect(result.metadata.token).toBe('[FILTERED]')
  })

  test('should filter objects inside arrays', () => {
    const data = {
      users: [
        { name: 'alice', password: 'secret1' },
        { name: 'bob', password: 'secret2' },
      ],
    }
    const result = filterSensitiveData(data, ['password']) as any

    expect(result.users[0].password).toBe('[FILTERED]')
    expect(result.users[1].password).toBe('[FILTERED]')
    expect(result.users[0].name).toBe('alice')
  })

  test('should use custom replacement string', () => {
    const data = { password: 'secret' }
    const result = filterSensitiveData(data, ['password'], '***')

    expect(result.password).toBe('***')
  })

  test('should return data unchanged when filterKeys is empty', () => {
    const data = { password: 'secret' }
    const result = filterSensitiveData(data, [])

    expect(result).toBe(data) // Same reference
  })
})

describe('Logger filtering', () => {
  test('should filter sensitive data in log context by default', () => {
    const { entries, channel } = createCapture()
    const logger = new Logger([channel])

    logger.info('login', { username: 'alice', password: 'secret123' })

    expect(entries[0].context.username).toBe('alice')
    expect(entries[0].context.password).toBe('[FILTERED]')
  })

  test('should filter default keys like token, secret, credit_card', () => {
    const { entries, channel } = createCapture()
    const logger = new Logger([channel])

    logger.info('data', {
      token: 'abc',
      secret: 'xyz',
      credit_card: '4111111111111111',
      authorization: 'Bearer token',
      name: 'visible',
    })

    expect(entries[0].context.token).toBe('[FILTERED]')
    expect(entries[0].context.secret).toBe('[FILTERED]')
    expect(entries[0].context.credit_card).toBe('[FILTERED]')
    expect(entries[0].context.authorization).toBe('[FILTERED]')
    expect(entries[0].context.name).toBe('visible')
  })

  test('should allow custom filter keys', () => {
    const { entries, channel } = createCapture()
    const logger = new Logger([channel], {}, { filterKeys: ['email'] })

    logger.info('data', { email: 'a@b.com', password: 'visible' })

    expect(entries[0].context.email).toBe('[FILTERED]')
    expect(entries[0].context.password).toBe('visible')
  })

  test('should allow disabling filtering with empty array', () => {
    const { entries, channel } = createCapture()
    const logger = new Logger([channel], {}, { filterKeys: [] })

    logger.info('data', { password: 'visible' })

    expect(entries[0].context.password).toBe('visible')
  })

  test('should propagate filter options to child loggers', () => {
    const { entries, channel } = createCapture()
    const parent = new Logger([channel], {}, { filterKeys: ['secret'] })
    const child = parent.withContext({ requestId: '123' })

    child.info('data', { secret: 'hidden', name: 'visible' })

    expect(entries[0].context.secret).toBe('[FILTERED]')
    expect(entries[0].context.name).toBe('visible')
    expect(entries[0].context.requestId).toBe('123')
  })
})
