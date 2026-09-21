import { describe, expect, mock, test } from 'bun:test'
import { createSqsAdapter } from '../../../src/queue/drivers/SqsDriver'

class Command {
  constructor(readonly input: Record<string, unknown>) {}
}
class ReceiveMessageCommand extends Command {}
class DeleteMessageCommand extends Command {}

// Only the optional SDK is replaced; driver tests use their own adapter objects.
await mock.module('@aws-sdk/client-sqs', () => ({
  ReceiveMessageCommand,
  DeleteMessageCommand,
}))

describe('createSqsAdapter', () => {
  test('requests and decodes the SQS receive count', async () => {
    const commands: unknown[] = []
    const adapter = createSqsAdapter({
      async send(command) {
        commands.push(command)
        return { Messages: [{ Body: '{}', ReceiptHandle: 'receipt', Attributes: { ApproximateReceiveCount: '3' } }] }
      },
    })
    expect(await adapter.receiveMessage({ queueUrl: 'https://example.test/queue' })).toEqual({
      body: '{}', receiptHandle: 'receipt', receiveCount: 3,
    })
    expect(commands[0]).toBeInstanceOf(ReceiveMessageCommand)
    expect((commands[0] as Command).input).toEqual({
      QueueUrl: 'https://example.test/queue', MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5, MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    })
  })

  test('reports no receive count when the client returns no attributes', async () => {
    const adapter = createSqsAdapter({
      async send() {
        return { Messages: [{ Body: '{}', ReceiptHandle: 'receipt' }] }
      },
    })
    expect(await adapter.receiveMessage({ queueUrl: 'https://example.test/queue' })).toEqual({
      body: '{}', receiptHandle: 'receipt', receiveCount: undefined,
    })
  })

  test('sends DeleteMessage with the queue URL and receipt handle', async () => {
    const commands: unknown[] = []
    const adapter = createSqsAdapter({ async send(command) { commands.push(command); return {} } })
    await adapter.deleteMessage!({ queueUrl: 'https://example.test/queue', receiptHandle: 'latest-receipt' })
    expect(commands[0]).toBeInstanceOf(DeleteMessageCommand)
    expect((commands[0] as Command).input).toEqual({
      QueueUrl: 'https://example.test/queue', ReceiptHandle: 'latest-receipt',
    })
  })
})
