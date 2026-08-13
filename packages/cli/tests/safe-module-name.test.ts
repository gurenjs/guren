import { describe, it, expect } from 'bun:test'
import { safeModuleName } from '../src/utils'

describe('safeModuleName', () => {
  it('kebab-cases a valid module name', () => {
    expect(safeModuleName('Billing')).toBe('billing')
    expect(safeModuleName('billingOps')).toBe('billing-ops')
    expect(safeModuleName('billing_ops')).toBe('billing-ops')
  })

  it('accepts digits after the leading letter', () => {
    expect(safeModuleName('s3')).toBe('s3')
    expect(safeModuleName('billing-2fa')).toBe('billing-2fa')
  })

  it('rejects a name starting with a digit', () => {
    // It is PascalCased into generated type names, and `2faInvoice` is not a
    // TypeScript identifier.
    expect(() => safeModuleName('2fa')).toThrow(/Invalid module name/)
    // Kebab-cases to `2-fa`, so only checking the first segment catches it.
    expect(() => safeModuleName('2FA')).toThrow(/Invalid module name/)
  })

  it('rejects a name that escapes modules/ via ..', () => {
    expect(() => safeModuleName('../../outside')).toThrow(/Invalid module name/)
    expect(() => safeModuleName('..')).toThrow(/Invalid module name/)
  })

  it('rejects a name containing a forward slash', () => {
    expect(() => safeModuleName('/etc/passwd')).toThrow(/Invalid module name/)
    expect(() => safeModuleName('billing/evil')).toThrow(/Invalid module name/)
  })

  it('rejects a name containing a backslash', () => {
    expect(() => safeModuleName('billing\\evil')).toThrow(/Invalid module name/)
  })

  it('rejects an empty or all-symbol name', () => {
    expect(() => safeModuleName('')).toThrow(/Invalid module name/)
    expect(() => safeModuleName('   ')).toThrow(/Invalid module name/)
    expect(() => safeModuleName('---')).toThrow(/Invalid module name/)
  })
})
