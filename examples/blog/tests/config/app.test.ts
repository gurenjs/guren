// @vitest-environment node
// The suite default is jsdom, where `import.meta.url` is an http URL and
// config/app.ts's `fileURLToPath(new URL(...))` throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { configureOrmMock, seedDatabaseMock } = vi.hoisted(() => ({
  configureOrmMock: vi.fn(),
  seedDatabaseMock: vi.fn(),
}))
vi.mock('../../config/database.js', () => ({
  configureOrm: configureOrmMock,
  seedDatabase: seedDatabaseMock,
}))

async function bootModelsFresh(): Promise<void> {
  // config/app.ts memoizes on a module-level flag, so each case needs its own instance.
  vi.resetModules()
  const { bootModels } = await import('../../config/app.js')
  await bootModels()
}

describe('bootModels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('seeds on boot outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development')

    await bootModelsFresh()

    expect(configureOrmMock).toHaveBeenCalledTimes(1)
    expect(seedDatabaseMock).toHaveBeenCalledTimes(1)
  })

  it('configures the ORM but never seeds in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')

    await bootModelsFresh()

    expect(configureOrmMock).toHaveBeenCalledTimes(1)
    expect(seedDatabaseMock).not.toHaveBeenCalled()
  })
})
