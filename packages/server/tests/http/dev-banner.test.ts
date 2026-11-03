import { describe, expect, it } from 'bun:test'

import { type DevBannerOptions, GUREN_ASCII_ART, logDevServerBanner } from '../../src/http/dev-banner'

function bannerFor(options: DevBannerOptions): string {
  const logs: string[] = []
  const originalLog = console.log
  console.log = (message: string) => {
    logs.push(message)
  }
  try {
    logDevServerBanner(options)
  } finally {
    console.log = originalLog
  }
  return logs.join('\n')
}

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

  it('says Guren started the Vite dev server it manages', () => {
    const banner = bannerFor({ hostname: 'localhost', port: 3000, assetsUrl: 'http://localhost:5173', assetServer: 'managed' })

    expect(banner).toContain('http://localhost:5173 (Vite, started by Guren)')
  })

  // VITE_DEV_SERVER_URL names an asset server Guren never starts, so the line must not read as a Vite it launched.
  it('says the developer runs an asset server Guren did not start', () => {
    const banner = bannerFor({ hostname: 'localhost', port: 3000, assetsUrl: 'http://localhost:4241', assetServer: 'external' })

    expect(banner).toContain('http://localhost:4241 (not started by Guren, run it yourself)')
    expect(banner).not.toContain('(Vite')
  })

  it('keeps the plain Vite label for a caller that does not say', () => {
    expect(bannerFor({ hostname: 'localhost', port: 3000 })).toContain('http://localhost:5173 (Vite)')
  })
})
