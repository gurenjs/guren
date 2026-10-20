import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { requiredDeployEnv } from '../src/deploy-env'
import { createTempWorkspace, linkWorkspaceCore, writeWorkspaceFiles, type TempWorkspace } from './helpers'

const ENV_SCHEMA = `import { defineEnv, Env } from '@guren/core'

export default defineEnv({
  APP_KEY: Env.string().secret(),
  APP_URL: Env.url().requiredInProduction(),
  REDIS_URL: Env.url().optional(),
  SESSION_DRIVER: Env.enum(['database', 'cookie']).default('database'),
})
`

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-deploy-env-')
  await linkWorkspaceCore(workspace.dir)
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('requiredDeployEnv', () => {
  test('lists the variables production requires and nothing defaulted or optional', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': ENV_SCHEMA })

    expect(await requiredDeployEnv(workspace.dir)).toEqual({ status: 'loaded', required: ['APP_KEY', 'APP_URL'] })
  })

  // A value set locally is not a value set on the deployed worker.
  test('ignores the local environment, and puts it back', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': ENV_SCHEMA })
    const before = { APP_KEY: process.env.APP_KEY, NODE_ENV: process.env.NODE_ENV }
    process.env.APP_KEY = 'base64:local'
    try {
      const result = await requiredDeployEnv(workspace.dir)

      expect(result).toEqual({ status: 'loaded', required: ['APP_KEY', 'APP_URL'] })
      expect(process.env.APP_KEY).toBe('base64:local')
      expect(process.env.NODE_ENV).toBe(before.NODE_ENV)
    } finally {
      if (before.APP_KEY === undefined) delete process.env.APP_KEY
      else process.env.APP_KEY = before.APP_KEY
    }
  })

  test('passes through an absent or unreadable schema', async () => {
    expect(await requiredDeployEnv(workspace.dir)).toEqual({ status: 'absent' })

    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': 'export default { APP_KEY: "x" }\n' })
    expect((await requiredDeployEnv(workspace.dir)).status).toBe('unreadable')
  })
})
