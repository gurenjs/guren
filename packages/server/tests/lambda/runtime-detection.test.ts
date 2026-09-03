import { describe, test, expect, afterEach } from 'bun:test'

import { isLambda, getLambdaContext } from '../../src/lambda'

describe('isLambda', () => {
  

  afterEach(() => {
    // Restore original env
    delete process.env.AWS_LAMBDA_FUNCTION_NAME
    delete process.env.AWS_LAMBDA_FUNCTION_VERSION
    delete process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE
    delete process.env.AWS_REGION
    delete process.env.AWS_LAMBDA_LOG_GROUP_NAME
    delete process.env.AWS_LAMBDA_LOG_STREAM_NAME
  })

  test('should return false when not on Lambda', () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME
    expect(isLambda()).toBe(false)
  })

  test('should return true when AWS_LAMBDA_FUNCTION_NAME is set', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function'
    expect(isLambda()).toBe(true)
  })
})

describe('getLambdaContext', () => {
  afterEach(() => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME
    delete process.env.AWS_LAMBDA_FUNCTION_VERSION
    delete process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE
    delete process.env.AWS_REGION
    delete process.env.AWS_LAMBDA_LOG_GROUP_NAME
    delete process.env.AWS_LAMBDA_LOG_STREAM_NAME
  })

  test('should return null when not on Lambda', () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME
    expect(getLambdaContext()).toBeNull()
  })

  test('should return context with metadata when on Lambda', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function'
    process.env.AWS_LAMBDA_FUNCTION_VERSION = '42'
    process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = '512'
    process.env.AWS_REGION = 'ap-northeast-1'
    process.env.AWS_LAMBDA_LOG_GROUP_NAME = '/aws/lambda/my-function'
    process.env.AWS_LAMBDA_LOG_STREAM_NAME = '2026/03/22/[$LATEST]abc123'

    const ctx = getLambdaContext()
    expect(ctx).not.toBeNull()
    expect(ctx!.functionName).toBe('my-function')
    expect(ctx!.functionVersion).toBe('42')
    expect(ctx!.memorySize).toBe(512)
    expect(ctx!.region).toBe('ap-northeast-1')
    expect(ctx!.logGroup).toBe('/aws/lambda/my-function')
    expect(ctx!.logStream).toBe('2026/03/22/[$LATEST]abc123')
    expect(ctx!.tmpDir).toBe('/tmp')
  })

  test('should use defaults for missing optional env vars', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'minimal'

    const ctx = getLambdaContext()
    expect(ctx).not.toBeNull()
    expect(ctx!.functionVersion).toBe('$LATEST')
    expect(ctx!.memorySize).toBe(128)
    expect(ctx!.region).toBe('us-east-1')
    expect(ctx!.logGroup).toBeUndefined()
  })
})
