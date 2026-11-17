import { createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import nodemailer from 'nodemailer'
import { describe, expect, it, vi } from 'vitest'
import { SmtpTransport } from '../../src/mail/transports/SmtpTransport'
import type { SmtpTransportOptions } from '../../src/mail/types'

for (const pool of [false, true]) {
  it(`sends through the installed SMTP client (pool=${pool})`, async () => {
    const sockets = new Set<Socket>()
    const messages: string[] = []
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.setEncoding('utf8')
      socket.write('220 localhost test SMTP\r\n')
      let pending = ''
      let body: string[] | undefined
      socket.on('data', (chunk) => {
        pending += chunk
        let end: number
        while ((end = pending.indexOf('\r\n')) !== -1) {
          const line = pending.slice(0, end)
          pending = pending.slice(end + 2)
          if (body) {
            if (line === '.') {
              messages.push(body.join('\r\n'))
              body = undefined
              socket.write('250 queued\r\n')
            } else {
              body.push(line)
            }
          } else if (line.startsWith('EHLO') || line.startsWith('HELO')) {
            socket.write('250 localhost\r\n')
          } else if (line === 'DATA') {
            body = []
            socket.write('354 End with dot\r\n')
          } else if (line === 'QUIT') {
            socket.end('221 goodbye\r\n')
          } else {
            socket.write('250 OK\r\n')
          }
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing SMTP port')
    const transport = new SmtpTransport({ host: '127.0.0.1', port: address.port, pool })
    try {
      expect(await transport.verify()).toBe(true)
      const result = await transport.send({
        from: { email: 'sender@example.test' },
        to: [{ email: 'recipient@example.test' }],
        subject: 'SMTP compatibility',
        text: 'Message delivered to the local fixture.',
      })
      expect(result.success).toBe(true)
      expect(result.messageId).toBeTruthy()
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain('Subject: SMTP compatibility')
      expect(messages[0]).toContain('Message delivered to the local fixture.')
    } finally {
      transport.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it(`sends neither credentials nor mail when requireTLS meets a server with no STARTTLS (pool=${pool})`, async () => {
    const sockets = new Set<Socket>()
    const commands: string[] = []
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.setEncoding('utf8')
      socket.write('220 localhost test SMTP\r\n')
      let pending = ''
      socket.on('data', (chunk) => {
        pending += chunk
        let end: number
        while ((end = pending.indexOf('\r\n')) !== -1) {
          const line = pending.slice(0, end)
          pending = pending.slice(end + 2)
          commands.push(line)
          if (line.startsWith('EHLO')) {
            socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n')
          } else if (line === 'STARTTLS') {
            socket.write('502 Not implemented\r\n')
          } else if (line === 'QUIT') {
            socket.end('221 goodbye\r\n')
          } else {
            socket.write('250 OK\r\n')
          }
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing SMTP port')
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: address.port,
      pool,
      requireTLS: true,
      auth: { user: 'relay-user', pass: 'relay-pass' },
    })
    try {
      const result = await transport.send({
        from: { email: 'sender@example.test' },
        to: [{ email: 'recipient@example.test' }],
        subject: 'Reset your password',
        text: 'A reset link.',
      })
      expect(result.success).toBe(false)
      expect(commands).toContain('STARTTLS')
      expect(commands.filter((line) => /^(AUTH|MAIL|DATA)\b/.test(line))).toEqual([])
    } finally {
      transport.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}

describe('SmtpTransport TLS options', () => {
  const relay = { host: 'smtp.example.test', auth: { user: 'relay-user', pass: 'relay-pass' } }

  function nodemailerOptions(options: SmtpTransportOptions, nodeEnv = 'production') {
    const savedNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = nodeEnv
    const createTransport = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({} as never)
    try {
      new SmtpTransport(options)
      return createTransport.mock.calls[0]?.[0] as { requireTLS?: boolean; tls?: unknown }
    } finally {
      createTransport.mockRestore()
      process.env.NODE_ENV = savedNodeEnv
    }
  }

  it('requires TLS by default when credentials go to a relay off this machine, in development too', () => {
    expect(nodemailerOptions(relay).requireTLS).toBe(true)
    expect(nodemailerOptions(relay, 'development').requireTLS).toBe(true)
    expect(nodemailerOptions({ ...relay, auth: { user: '', pass: 'relay-pass' } }).requireTLS).toBe(true)
    expect(nodemailerOptions({ ...relay, host: '10.0.0.5' }).requireTLS).toBe(true)
    expect(nodemailerOptions({ ...relay, host: 'mailpit' }).requireTLS).toBe(true)
    expect(nodemailerOptions({ ...relay, host: '::ffff:8.8.8.8' }).requireTLS).toBe(true)
    expect(nodemailerOptions({ ...relay, host: '127.0.0.1.example.test' }).requireTLS).toBe(true)
  })

  for (const host of [
    'localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '127.1', '::1', '[::1]', '',
    '0:0:0:0:0:0:0:1', '[0:0:0:0:0:0:0:1]', '::ffff:127.0.0.1', '::ffff:7f00:1',
  ]) {
    it(`leaves requireTLS off by default for a mail catcher on this machine (host=${JSON.stringify(host)})`, () => {
      expect(nodemailerOptions({ ...relay, host }).requireTLS).toBe(false)
    })
  }

  it('leaves requireTLS off by default when no credentials are sent', () => {
    expect(nodemailerOptions({ host: 'smtp.example.test' }).requireTLS).toBe(false)
    expect(nodemailerOptions({ host: 'smtp.example.test', auth: { user: '', pass: '' } }).requireTLS).toBe(false)
  })

  it('leaves requireTLS off by default on an implicit TLS connection', () => {
    expect(nodemailerOptions({ ...relay, port: 465, secure: true }).requireTLS).toBe(false)
  })

  it('forwards requireTLS: false for a relay that takes credentials without STARTTLS', () => {
    expect(nodemailerOptions({ ...relay, requireTLS: false }).requireTLS).toBe(false)
  })

  it('forwards requireTLS: true to nodemailer', () => {
    expect(nodemailerOptions({ ...relay, requireTLS: true }).requireTLS).toBe(true)
  })

  it('forwards tls to nodemailer', () => {
    const tls = { ca: 'private-ca', servername: 'relay.internal' }
    expect(nodemailerOptions({ ...relay, tls }).tls).toEqual(tls)
  })
})
