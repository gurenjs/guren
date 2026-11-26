import { afterEach, describe, expect, it } from 'bun:test'
import { LogTransport, type MailMessage } from '../../src/mail'

const RESET_URL = 'https://app.example.com/reset-password?token=0f3a9c&email=ada%40example.com'
const SIGNED_URL = 'https://app.example.com/download?expires=1700000000&signature=eyJ1cmwiOiIvZCJ9.c2lnLV9h'

function message(body: Partial<Pick<MailMessage, 'text' | 'html'>>): MailMessage {
  return {
    from: { email: 'noreply@example.com' },
    to: [{ email: 'ada@example.com' }],
    subject: 'Reset your password',
    ...body,
  }
}

async function logged(mail: MailMessage): Promise<string> {
  const lines: string[] = []
  const result = await new LogTransport({ logger: (line) => lines.push(line) }).send(mail)
  expect(result.success).toBe(true)
  return lines.join('\n')
}

function expectedOutput(body: string): string {
  return [
    '[mail] ------------------------------------------------------------',
    '[mail] To: ada@example.com',
    '[mail] From: noreply@example.com',
    '[mail] Subject: Reset your password',
    `[mail] ${body.split('\n').join('\n[mail] ')}`,
    '[mail] ------------------------------------------------------------',
  ].join('\n')
}

describe('LogTransport', () => {
  const nodeEnv = process.env.NODE_ENV
  afterEach(() => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
  })

  it('writes the whole message outside production', async () => {
    process.env.NODE_ENV = 'development'
    const text = `Reset it here:\n${RESET_URL}\nOr download: ${SIGNED_URL}.`

    expect(await logged(message({ text }))).toBe(expectedOutput(text))
  })

  describe('under NODE_ENV=production', () => {
    it('redacts the token and signature values in a text body and nothing else', async () => {
      process.env.NODE_ENV = 'production'
      const text = `Reset it here:\n${RESET_URL}\nOr download: ${SIGNED_URL}.`

      expect(await logged(message({ text }))).toBe(
        expectedOutput(
          'Reset it here:\n' +
            'https://app.example.com/reset-password?token=[redacted]&email=ada%40example.com\n' +
            'Or download: https://app.example.com/download?expires=1700000000&signature=[redacted].',
        ),
      )
    })

    it('redacts an html-only body, after an escaped ampersand too', async () => {
      process.env.NODE_ENV = 'production'
      const html =
        '<a href="https://app.example.com/reset-password?token=0f3a9c&amp;email=ada%40example.com">Reset</a> ' +
        '<a href="https://app.example.com/download?expires=1&amp;signature=eyJ1cmwiOiIvZCJ9.c2lnLV9h#top">Download</a>'

      expect(await logged(message({ html }))).toBe(
        expectedOutput(
          '<a href="https://app.example.com/reset-password?token=[redacted]&amp;email=ada%40example.com">Reset</a> ' +
            '<a href="https://app.example.com/download?expires=1&amp;signature=[redacted]#top">Download</a>',
        ),
      )
    })

    it('leaves every other parameter, fragment and lookalike name as written', async () => {
      process.env.NODE_ENV = 'production'
      const text =
        'https://app.example.com/posts?page=2&utm_source=mail#section\n' +
        'https://app.example.com/cb?access_token=abc&mytoken=def\n' +
        '(https://app.example.com/reset?token=0f3a9c)'

      expect(await logged(message({ text }))).toBe(
        expectedOutput(
          'https://app.example.com/posts?page=2&utm_source=mail#section\n' +
            'https://app.example.com/cb?access_token=abc&mytoken=def\n' +
            '(https://app.example.com/reset?token=[redacted])',
        ),
      )
    })
  })
})
