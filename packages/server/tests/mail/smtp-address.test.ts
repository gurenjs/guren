import nodemailer from 'nodemailer'
import { describe, expect, it, vi } from 'vitest'
import { parseMailAddress } from '../../src/mail/address'
import { SmtpTransport } from '../../src/mail/transports/SmtpTransport'
import type { MailAddress, MailMessage } from '../../src/mail/types'

const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })

interface Delivered {
  envelope: { from: string | false; to: string[] }
  headers: Map<string, string>
}

function delivered(info: { envelope: Delivered['envelope']; message: unknown }): Delivered {
  const [head = ''] = (info.message as Buffer).toString('utf8').split('\r\n\r\n')
  const headers = new Map<string, string>()
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':')
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim())
  }
  return { envelope: info.envelope, headers }
}

async function sendThroughSmtpTransport(message: Omit<MailMessage, 'subject' | 'text'>): Promise<Delivered> {
  let sent: Delivered | undefined
  const createTransport = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
    sendMail: async (options: Parameters<typeof stream.sendMail>[0]) => {
      const info = await stream.sendMail(options)
      sent = delivered(info)
      return info
    },
    close: () => {},
  } as never)
  try {
    const result = await new SmtpTransport({ host: 'smtp.example.test' }).send({ ...message, subject: 'Subject', text: 'Body' })
    expect(result.error).toBeUndefined()
  } finally {
    createTransport.mockRestore()
  }
  if (!sent) throw new Error('SmtpTransport sent nothing')
  return sent
}

async function sendComposed(to: string): Promise<Delivered> {
  return delivered(await stream.sendMail({ to, subject: 'Subject', text: 'Body' }))
}

describe('SmtpTransport display names', () => {
  const plainNamed: Array<[MailAddress, string]> = [
    ...[
      'victim@corp.test',
      'john@corp.test (John)',
      '(John) john@corp.test',
      'victim @ corp.test',
      'x@corp.test attacker@evil.test',
      'x@corp.test (y@evil.test',
    ].map((email): [MailAddress, string] => [{ name: 'Bob', email }, `"Bob" <${email}>`]),
    [{ name: 42 as unknown as string, email: 'n@corp.test' }, '"42" <n@corp.test>'],
    [{ name: 'Bob', email: undefined as unknown as string }, '"Bob" <undefined>'],
  ]

  for (const [address, composed] of plainNamed) {
    it(`delivers ${JSON.stringify(address)} as ${JSON.stringify(composed)} does`, async () => {
      const smtp = await sendThroughSmtpTransport({ to: [address] })
      const expected = await sendComposed(composed)
      expect(smtp.envelope).toEqual(expected.envelope)
      expect(smtp.headers.get('to')).toBe(expected.headers.get('to'))
    })
  }

  it('keeps a name that closes its own quotes out of the recipients', async () => {
    const name = 'x" <attacker@evil.test>, "y'
    const smtp = await sendThroughSmtpTransport({
      from: { name, email: 'app@corp.test' },
      to: [{ name, email: 'victim@corp.test' }],
      replyTo: { name, email: 'app@corp.test' },
    })
    expect(smtp.envelope).toEqual({ from: 'app@corp.test', to: ['victim@corp.test'] })
    expect(smtp.headers.get('to')).toBe('"x\\" <attacker@evil.test>, \\"y" <victim@corp.test>')
    expect(smtp.headers.get('reply-to')).toBe('"x\\" <attacker@evil.test>, \\"y" <app@corp.test>')
  })

  it('does not let a name ending in a backslash escape its closing quote', async () => {
    const smtp = await sendThroughSmtpTransport({ to: [{ name: 'a\\', email: 'victim@corp.test' }] })
    expect(smtp.envelope.to).toEqual(['victim@corp.test'])
    expect(smtp.headers.get('to')).toBe('"a\\\\" <victim@corp.test>')
  })

  it('reads a name parseMailAddress leaves quoted as one display name', async () => {
    const smtp = await sendThroughSmtpTransport({ to: [parseMailAddress('"Jane Doe" <jane@corp.test>')] })
    expect(smtp.envelope.to).toEqual(['jane@corp.test'])
    expect(smtp.headers.get('to')).toBe('Jane Doe <jane@corp.test>')
  })
})
