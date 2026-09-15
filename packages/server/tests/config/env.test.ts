import { describe, expect, test } from 'bun:test'
import { AGENT_REDACTED } from '../../src/agent/redact'
import { defineEnv, Env, EnvValidationError, isRawEnvKey, type InferEnv } from '../../src/config/env'
import { withEnv } from '../support/env'

describe('defineEnv().parse()', () => {
  test('treats a blank value as unset, so a default applies to both', () => {
    const env = defineEnv({ RFC27_DRIVER: Env.string().default('database') })

    expect(env.parse({ RFC27_DRIVER: '' }).values.RFC27_DRIVER).toBe('database')
    expect(env.parse({}).values.RFC27_DRIVER).toBe('database')
  })

  test('keeps an empty string only for a variable declared allowEmpty()', () => {
    const env = defineEnv({ RFC27_NAME: Env.string().allowEmpty().default('Guren') })

    expect(env.parse({ RFC27_NAME: '' }).values.RFC27_NAME).toBe('')
  })

  test('resolves an unset optional variable to undefined', () => {
    const env = defineEnv({ RFC27_OPTIONAL: Env.url().optional() })

    expect(env.parse({}).values.RFC27_OPTIONAL).toBeUndefined()
  })

  test('coerces numbers, ports and booleans, and rejects what does not parse', () => {
    const env = defineEnv({
      RFC27_PORT: Env.port(),
      RFC27_RATIO: Env.number(),
      RFC27_FLAG: Env.boolean(),
    })

    expect(env.parse({ RFC27_PORT: '587', RFC27_RATIO: '0.5', RFC27_FLAG: '1' }).values).toEqual({
      RFC27_PORT: 587,
      RFC27_RATIO: 0.5,
      RFC27_FLAG: true,
    })

    const { problems } = env.parse({ RFC27_PORT: '70000', RFC27_RATIO: 'abc', RFC27_FLAG: 'yes' }, { mode: 'report' })
    expect(problems.map((problem) => problem.message)).toEqual([
      '"70000" is not a port',
      '"abc" is not a number',
      '"yes" is not a boolean (true, false, 1 or 0)',
    ])
  })

  test('accepts only the values an enum declares', () => {
    const env = defineEnv({ RFC27_STORE: Env.enum(['database', 'cookie']) })

    expect(env.parse({ RFC27_STORE: 'cookie' }).values.RFC27_STORE).toBe('cookie')
    expect(() => env.parse({ RFC27_STORE: 'redis' })).toThrow('"redis" is not one of: database, cookie')
  })

  test('runs a synchronous Standard Schema and reports an asynchronous one', () => {
    const upper = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => typeof value === 'string' && value === value.toUpperCase()
          ? { value }
          : { issues: [{ message: 'must be upper case' }] },
      },
    }
    const pending = {
      '~standard': { version: 1 as const, vendor: 'test', validate: async (value: unknown) => ({ value }) },
    }
    const env = defineEnv({ RFC27_CODE: Env.custom(upper), RFC27_LATER: Env.custom(pending) })

    const { values, problems } = env.parse({ RFC27_CODE: 'abc', RFC27_LATER: 'x' }, { mode: 'report' })
    expect(problems.map((problem) => problem.message)).toEqual([
      '"abc" is invalid: must be upper case',
      '"x" has an asynchronous validator; Env.custom() accepts synchronous validators only',
    ])
    expect(values.RFC27_CODE).toBe(AGENT_REDACTED)
    expect(env.parse({ RFC27_CODE: 'ABC', RFC27_LATER: 'x' }, { mode: 'report' }).values.RFC27_CODE).toBe('ABC')
  })

  test('never echoes a secret value in a problem', () => {
    const env = defineEnv({ RFC27_SECRET_PORT: Env.port().secret() })

    expect(() => env.parse({ RFC27_SECRET_PORT: 'hunter2' })).toThrow('value is not a port')
    expect(() => env.parse({ RFC27_SECRET_PORT: 'hunter2' })).not.toThrow('hunter2')
  })

  test('requires a requiredInProduction() variable only when NODE_ENV is production', async () => {
    const env = defineEnv({ RFC27_APP_URL: Env.url().requiredInProduction() })

    await withEnv({ NODE_ENV: 'development' }, async () => {
      expect(env.parse({}).values.RFC27_APP_URL).toBeUndefined()
    })
    await withEnv({ NODE_ENV: 'production' }, async () => {
      expect(() => env.parse({})).toThrow('RFC27_APP_URL')
    })
  })

  test('reads the source first and falls back to process.env for each declared key', async () => {
    const env = defineEnv({ RFC27_FROM_PROCESS: Env.string(), RFC27_OVERRIDDEN: Env.string() })

    await withEnv({ RFC27_FROM_PROCESS: 'process', RFC27_OVERRIDDEN: 'process' }, async () => {
      expect(env.parse({ RFC27_OVERRIDDEN: 'source' }).values).toEqual({
        RFC27_FROM_PROCESS: 'process',
        RFC27_OVERRIDDEN: 'source',
      })
    })
  })

  test('ignores a non-string source value, such as a Workers binding object', async () => {
    const env = defineEnv({ RFC27_BOUND: Env.string() })

    await withEnv({ RFC27_BOUND: 'from-process' }, async () => {
      expect(env.parse({ RFC27_BOUND: { prepare() {} } }).values.RFC27_BOUND).toBe('from-process')
    })
  })

  test('re-reads process.env on every call rather than caching per source', async () => {
    const env = defineEnv({ RFC27_MUTATED: Env.string().optional() })

    await withEnv({ RFC27_MUTATED: undefined }, async () => {
      expect(env.parse().values.RFC27_MUTATED).toBeUndefined()
      process.env.RFC27_MUTATED = 'later'
      expect(env.parse().values.RFC27_MUTATED).toBe('later')
    })
  })

  test('throws one error listing every problem', () => {
    const env = defineEnv({ RFC27_KEY: Env.string(), RFC27_SMTP_PORT: Env.port() })

    let error: unknown
    try {
      env.parse({ RFC27_SMTP_PORT: 'abc' })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(EnvValidationError)
    expect((error as EnvValidationError).problems).toHaveLength(2)
    expect((error as Error).message).toBe(
      '[guren] Invalid environment (2 problems):\n'
      + '  RFC27_KEY        required, not set\n'
      + '  RFC27_SMTP_PORT  "abc" is not a port',
    )
  })

  test('report mode returns placeholders and the keys that hold them instead of throwing', () => {
    const env = defineEnv({ RFC27_REQUIRED: Env.string(), RFC27_FINE: Env.string().default('ok') })

    const parsed = env.parse({}, { mode: 'report' })

    expect(parsed.values).toEqual({ RFC27_REQUIRED: AGENT_REDACTED, RFC27_FINE: 'ok' })
    expect([...parsed.unset]).toEqual(['RFC27_REQUIRED'])
    expect(parsed.problems).toEqual([{ key: 'RFC27_REQUIRED', message: 'required, not set' }])
  })

  test('infers the value types from the builders', () => {
    const env = defineEnv({
      RFC27_A: Env.string(),
      RFC27_B: Env.port().default(587),
      RFC27_C: Env.enum(['x', 'y']).optional(),
      RFC27_D: Env.url().requiredInProduction(),
    })
    type Values = InferEnv<typeof env>

    const values: Values = { RFC27_A: 'a', RFC27_B: 1, RFC27_C: undefined, RFC27_D: undefined }
    // @ts-expect-error an enum only admits its declared values
    const wrong: Values['RFC27_C'] = 'z'

    expect([values, wrong]).toHaveLength(2)
  })
})

describe('EnvVar accessors', () => {
  test('report the builder, presence, default and enum choices a variable was declared with', () => {
    const driver = Env.enum(['database', 'cookie']).default('database').describe('Session store.')
    const key = Env.string().secret()
    const url = Env.url().requiredInProduction()
    const port = Env.port().optional()

    expect([driver.type, driver.presence, driver.defaultValue, driver.choices, driver.description])
      .toEqual(['enum', 'defaulted', 'database', ['database', 'cookie'], 'Session store.'])
    expect([key.type, key.presence, key.defaultValue, key.choices, key.isSecret])
      .toEqual(['string', 'required', undefined, undefined, true])
    expect([url.type, url.presence]).toEqual(['url', 'production'])
    expect([port.type, port.presence]).toEqual(['port', 'optional'])
  })

  test('keeps the accessors across modifiers, which each return a new variable', () => {
    const declared = Env.boolean().default(false).allowEmpty().secret()

    expect([declared.type, declared.presence, declared.defaultValue]).toEqual(['boolean', 'defaulted', false])
  })
})

describe('defineEnv() declarations', () => {
  test('refuses NODE_ENV and GUREN_* keys, naming the reason', () => {
    expect(() => defineEnv({ NODE_ENV: Env.string() })).toThrow('bundlers can fold production gates')
    expect(() => defineEnv({ GUREN_MCP: Env.boolean() })).toThrow('GUREN_MCP cannot be declared')
  })

  test('refuses a key that is not an environment variable name', () => {
    expect(() => defineEnv({ 'app-url': Env.url() })).toThrow('"app-url" is not an environment variable name')
  })

  test('isRawEnvKey() matches exactly the keys a schema may not declare', () => {
    expect(isRawEnvKey('NODE_ENV')).toBe(true)
    expect(isRawEnvKey('GUREN_TESTING')).toBe(true)
    expect(isRawEnvKey('APP_URL')).toBe(false)
    expect(isRawEnvKey('NODE_OPTIONS')).toBe(false)
  })
})
