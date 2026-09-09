import { describe, expect, it } from 'vitest'
import { BUNDLE_BUDGET_KIB, judgeBundleSize, parseWranglerSize } from '../../scripts/lib/bundle-size.js'

const WRANGLER_OUTPUT = `
 ⛅️ wrangler 4.129.0
───────────────────
Total Upload: 4935.14 KiB / gzip: 900.47 KiB
--dry-run: exiting now.
`

describe('parseWranglerSize', () => {
  it('should read the uncompressed and gzip sizes wrangler prints', () => {
    expect(parseWranglerSize(WRANGLER_OUTPUT)).toEqual({ totalKiB: 4935.14, gzipKiB: 900.47 })
  })

  it('should normalise the unit to KiB when wrangler picks another', () => {
    expect(parseWranglerSize('Total Upload: 1.5 MiB / gzip: 512 B')).toEqual({
      totalKiB: 1536,
      gzipKiB: 0.5,
    })
  })

  it('should return null rather than a size when the line is missing', () => {
    expect(parseWranglerSize('Something else entirely')).toBeNull()
  })
})

describe('judgeBundleSize', () => {
  it('should pass a bundle within the budget and say how much of it is used', () => {
    const verdict = judgeBundleSize({ totalKiB: 4935, gzipKiB: 900 })

    expect(verdict.ok).toBe(true)
    expect(verdict.message).toContain('4935 KiB uncompressed (gzip 900 KiB)')
    expect(verdict.message).toContain(`40% of the ${BUNDLE_BUDGET_KIB} KiB budget`)
  })

  it('should fail a bundle over the budget and name the file that holds it', () => {
    const verdict = judgeBundleSize({ totalKiB: 28_622, gzipKiB: null }, 12_288)

    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('233% of the 12288 KiB budget')
    expect(verdict.message).toContain('Over budget')
    expect(verdict.message).toContain('web/scripts/lib/bundle-size.ts')
  })

  it('should treat the budget itself as within budget', () => {
    expect(judgeBundleSize({ totalKiB: 12_288, gzipKiB: null }, 12_288).ok).toBe(true)
  })
})
