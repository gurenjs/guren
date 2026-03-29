import { describe, expect, it } from 'bun:test'

import { GUREN_ASCII_ART, logDevServerBanner } from '../../src/http/dev-banner'

describe('dev banner', () => {
  it('creates a non-empty banner string', () => {
    expect(typeof GUREN_ASCII_ART).toBe('string')
    expect(GUREN_ASCII_ART.trim().length).toBeGreaterThan(0)
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
