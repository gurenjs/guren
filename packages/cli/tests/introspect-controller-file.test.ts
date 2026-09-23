import { describe, expect, test } from 'bun:test'

import { pickDeclaringFile } from '../src/introspect-controller-file'

const declaring = { file: '/app/app/Http/Controllers/billing.ts', exportName: 'InvoiceController' }
const barrel = { file: '/app/app/Http/Controllers/index.ts', exportName: 'InvoiceController' }
const named = { file: '/app/app/Http/Controllers/InvoiceController.ts', exportName: 'default' }

describe('pickDeclaringFile()', () => {
  test('prefers a non-barrel over a barrel, whichever the filesystem lists first', () => {
    expect(pickDeclaringFile([barrel, declaring], 'InvoiceController')).toBe(declaring)
    expect(pickDeclaringFile([declaring, barrel], 'InvoiceController')).toBe(declaring)
  })

  test('prefers the file named after the class over any other', () => {
    expect(pickDeclaringFile([barrel, declaring, named], 'InvoiceController')).toBe(named)
  })

  test('falls back to the only candidate, even a barrel', () => {
    expect(pickDeclaringFile([barrel], 'InvoiceController')).toBe(barrel)
    expect(pickDeclaringFile([], 'InvoiceController')).toBeUndefined()
  })
})
