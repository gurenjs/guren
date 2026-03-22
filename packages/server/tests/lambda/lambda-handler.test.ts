import { describe, test, expect } from 'bun:test'

import { createApp } from '../../src/http/Application'
import { createLambdaHandler } from '../../src/lambda'
import type { LambdaEvent } from '../../src/lambda'

function createApiGatewayV2Event(path: string): LambdaEvent {
  return {
    version: '2.0',
    routeKey: `GET ${path}`,
    rawPath: path,
    rawQueryString: '',
    body: null,
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'id.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'id',
      http: {
        method: 'GET',
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'id',
      routeKey: `GET ${path}`,
      stage: '$default',
      time: '12/Mar/2020:19:03:58 +0000',
      timeEpoch: 1583348638390,
    },
    isBase64Encoded: false,
  } as LambdaEvent
}

describe('createLambdaHandler', () => {
  test('should return a function', async () => {
    const app = createApp({
      routes(router) {
        router.get('/hello', (c) => c.json({ message: 'hello' }))
      },
    })
    await app.boot()

    const handler = createLambdaHandler(app)

    expect(typeof handler).toBe('function')
  })

  test('should handle API Gateway v2 event', async () => {
    const app = createApp({
      routes(router) {
        router.get('/ping', (c) => c.json({ pong: true }))
      },
    })
    await app.boot()

    const handler = createLambdaHandler(app)

    const event = createApiGatewayV2Event('/ping')

    const result = await handler(event, {} as any)

    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.pong).toBe(true)
  })

  test('should return 404 for unknown routes', async () => {
    const app = createApp({
      routes(router) {
        router.get('/exists', (c) => c.text('ok'))
      },
    })
    await app.boot()

    const handler = createLambdaHandler(app)

    const event = createApiGatewayV2Event('/not-found')

    const result = await handler(event, {} as any)

    expect(result.statusCode).toBe(404)
  })
})
