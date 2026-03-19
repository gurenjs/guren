import { describe, expect, it, mock } from 'bun:test'

const passthrough = (value: string) => value
const magenta = Object.assign((value: string) => value, { bold: (value: string) => value })

await mock.module('chalk', () => ({
  default: {
    redBright: { bold: (value: string) => value },
    magentaBright: magenta,
    bold: passthrough,
    cyanBright: passthrough,
    yellowBright: passthrough,
  },
}))

await mock.module('figlet', () => ({
  default: {
    textSync: () => 'ASCII',
  },
}))

const { GUREN_ASCII_ART, logDevServerBanner } = await import('../../src/http/dev-banner')

describe('dev banner', () => {
  it('renders ASCII art using figlet', () => {
    expect(GUREN_ASCII_ART).toBe('ASCII')
  })

  it('prints the dev server banner', () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (message: string) => {
      logs.push(message)
    }

    try {
      logDevServerBanner({ hostname: 'localhost', port: 3000, assetsUrl: 'http://localhost:5173' })
      expect(logs[0]).toContain('Guren v')
      expect(logs[0]).toContain('http://localhost:3000')
      expect(logs[0]).toContain('http://localhost:5173')
    } finally {
      console.log = originalLog
    }
  })
})
