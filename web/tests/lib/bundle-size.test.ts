import { describe, expect, it } from 'vitest'
import { BUNDLE_BUDGET_KIB, judgeBundleSize } from '../../scripts/lib/bundle-size.js'

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
