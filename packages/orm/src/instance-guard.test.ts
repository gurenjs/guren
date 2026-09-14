import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'

import { registerOrmInstance } from './instance-guard'

const INSTANCE_KEY = Symbol.for('guren.orm.loaded')

type Marker = { count: number; warned: boolean; identities?: Set<string> }
type GlobalWithMarker = typeof globalThis & { [INSTANCE_KEY]?: Marker }

const globalScope = globalThis as GlobalWithMarker

// Importing the guard registers this checkout's own copy; restoring it keeps the
// rest of the suite seeing the process it actually ran in.
const realMarker = globalScope[INSTANCE_KEY]

let warnings: string[] = []
const realWarn = console.warn
// `process.env` is one object per process, which `--isolate` does not fork.
const realQuiet = process.env.GUREN_QUIET_DUPLICATE_ORM

beforeEach(() => {
  warnings = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }
  delete globalScope[INSTANCE_KEY]
  delete process.env.GUREN_QUIET_DUPLICATE_ORM
})

afterEach(() => {
  console.warn = realWarn
  if (process.execArgv.includes('--hot')) {
    process.execArgv.splice(process.execArgv.indexOf('--hot'), 1)
  }
  if (realQuiet === undefined) delete process.env.GUREN_QUIET_DUPLICATE_ORM
  else process.env.GUREN_QUIET_DUPLICATE_ORM = realQuiet
})

afterAll(() => {
  if (realMarker) globalScope[INSTANCE_KEY] = realMarker
  else delete globalScope[INSTANCE_KEY]
})

function underHotReload(): void {
  process.execArgv.push('--hot')
}

const INSTALLED = 'file:///app/node_modules/@guren/orm/dist/index.js'
const LINKED = 'file:///app/packages/orm/src/index.ts'

describe('registerOrmInstance', () => {
  test('a single copy does not warn', () => {
    registerOrmInstance(INSTALLED)

    expect(warnings).toEqual([])
    expect(globalScope[INSTANCE_KEY]?.count).toBe(1)
  })

  test('re-evaluating the same copy under --hot is not a second copy', () => {
    underHotReload()

    registerOrmInstance(INSTALLED)
    registerOrmInstance(INSTALLED)
    registerOrmInstance(INSTALLED)

    expect(warnings).toEqual([])
    expect(globalScope[INSTANCE_KEY]?.count).toBe(1)
  })

  test('two distinct copies under --hot still warn, once', () => {
    underHotReload()

    registerOrmInstance(INSTALLED)
    registerOrmInstance(LINKED)
    registerOrmInstance(INSTALLED)
    registerOrmInstance(LINKED)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('2 copies of @guren/orm')
    expect(globalScope[INSTANCE_KEY]?.count).toBe(2)
  })

  test('a third copy does not warn again', () => {
    registerOrmInstance(INSTALLED)
    registerOrmInstance(LINKED)
    registerOrmInstance('file:///app/other/orm/index.js')

    expect(warnings).toHaveLength(1)
    expect(globalScope[INSTANCE_KEY]?.count).toBe(3)
  })

  test('a repeated identity outside --hot is two copies inlined in one bundle', () => {
    // Nothing re-evaluates a module without --hot, so the same URL twice is a
    // Workers/Lambda bundle carrying both copies at the bundle's own URL.
    registerOrmInstance(INSTALLED)
    registerOrmInstance(INSTALLED)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('2 copies of @guren/orm')
  })

  test('an unidentifiable copy warns rather than assuming a reload', () => {
    underHotReload()

    registerOrmInstance(undefined)
    registerOrmInstance(undefined)

    expect(warnings).toHaveLength(1)
  })

  test('a marker left by a copy predating identity tracking counts as a copy', () => {
    underHotReload()
    globalScope[INSTANCE_KEY] = { count: 1, warned: false }

    registerOrmInstance(INSTALLED)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('2 copies of @guren/orm')
  })

  test('GUREN_QUIET_DUPLICATE_ORM=1 silences a genuine duplicate', () => {
    process.env.GUREN_QUIET_DUPLICATE_ORM = '1'

    registerOrmInstance(INSTALLED)
    registerOrmInstance(LINKED)

    expect(warnings).toEqual([])
    expect(globalScope[INSTANCE_KEY]?.count).toBe(2)
  })
})
