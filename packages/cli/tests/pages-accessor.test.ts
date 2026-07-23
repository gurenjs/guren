import { describe, it, expect } from 'bun:test'
import { pagesAccessor } from '../src/utils'

describe('pagesAccessor', () => {
  it('builds a plain dotted path with no module', () => {
    expect(pagesAccessor(undefined, 'invoices')).toBe('pages.invoices')
  })

  it('nests a module name ahead of the page key', () => {
    expect(pagesAccessor('billing', 'invoices')).toBe('pages.billing.invoices')
  })

  it('bracket-quotes a module name that is not a valid identifier', () => {
    expect(pagesAccessor('billing-ops', 'invoices')).toBe("pages['billing-ops'].invoices")
  })

  it('bracket-quotes a page key that is not a valid identifier', () => {
    expect(pagesAccessor(undefined, 'my-page')).toBe("pages['my-page']")
  })

  it('escapes single quotes and backslashes in a bracket-quoted key', () => {
    expect(pagesAccessor("it's-a-module", 'invoices')).toBe("pages['it\\'s-a-module'].invoices")
  })

  it('drops falsy segments', () => {
    expect(pagesAccessor(undefined, undefined, 'invoices')).toBe('pages.invoices')
  })
})
