import { createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { SmtpTransport } from '../../src/mail/transports/SmtpTransport'

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
}
