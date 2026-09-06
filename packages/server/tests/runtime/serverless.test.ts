import { describe, expect, it } from 'bun:test'
import { detectServerlessRuntime, SERVERLESS_RUNTIME_LABELS } from '../../src/runtime/serverless'
import { isLambda } from '../../src/lambda'
import { withEnv } from '../support/env'

const OFF = { AWS_LAMBDA_FUNCTION_NAME: undefined, AWS_SAM_LOCAL: undefined, VERCEL: undefined, VERCEL_ENV: undefined }

describe('detectServerlessRuntime', () => {
  it.each([
    [{ AWS_LAMBDA_FUNCTION_NAME: 'app' }, { id: 'lambda' }],
    [{ AWS_LAMBDA_FUNCTION_NAME: 'app', AWS_SAM_LOCAL: 'true' }, { id: 'lambda', emulator: 'sam-local' }],
    [{ VERCEL: '1' }, { id: 'vercel' }],
    [{ VERCEL: '1', VERCEL_ENV: 'development' }, { id: 'vercel', emulator: 'vercel-dev' }],
    [{ VERCEL: '1', VERCEL_ENV: 'production' }, { id: 'vercel' }],
    [{}, undefined],
  ] as const)('should read %o as %o', async (env, expected) => {
    await withEnv({ ...OFF, ...env }, async () => {
      expect(detectServerlessRuntime()).toEqual(expected as never)
    })
  })

  it('should prefer Lambda over Vercel when both variables are set', async () => {
    await withEnv({ ...OFF, AWS_LAMBDA_FUNCTION_NAME: 'app', VERCEL: '1' }, async () => {
      expect(detectServerlessRuntime()?.id).toBe('lambda')
    })
  })

  it('should back isLambda(), emulator included', async () => {
    await withEnv({ ...OFF, AWS_LAMBDA_FUNCTION_NAME: 'app', AWS_SAM_LOCAL: 'true' }, async () => {
      expect(isLambda()).toBe(true)
    })
    await withEnv(OFF, async () => {
      expect(isLambda()).toBe(false)
    })
  })

  it('should carry a label for every runtime id', () => {
    for (const id of ['cloudflare', 'lambda', 'vercel'] as const) {
      expect(SERVERLESS_RUNTIME_LABELS[id]).toBeTruthy()
    }
  })
})
