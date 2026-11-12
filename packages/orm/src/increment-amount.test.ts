import { describe, expect, test } from 'bun:test'
import { DECIMAL_LITERAL, signedAmount } from './increment-amount'

describe('signedAmount', () => {
  test('should keep an amount as given for an increment', () => {
    expect(signedAmount('Post.increment', 2, 1)).toBe(2)
    expect(signedAmount('Post.increment', 2n, 1)).toBe(2n)
    expect(signedAmount('Post.increment', '10.50', 1)).toBe('10.50')
  })

  test('should negate each kind for a decrement', () => {
    expect(signedAmount('Post.decrement', 2, -1)).toBe(-2)
    expect(signedAmount('Post.decrement', 2n, -1)).toBe(-2n)
    expect(signedAmount('Post.decrement', '10.50', -1)).toBe('-10.50')
    expect(signedAmount('Post.decrement', '-10.50', -1)).toBe('10.50')
  })

  test('should refuse a number that is not finite', () => {
    expect(() => signedAmount('Post.increment', Number.NaN, 1)).toThrow(TypeError)
    expect(() => signedAmount('Post.increment', Number.NEGATIVE_INFINITY, 1)).toThrow(TypeError)
  })

  test('should refuse a string that is not one decimal literal, quoting it', () => {
    for (const amount of ['', '1e3', '1,5', ' 1', '1 ', '+1', '.5', '1.', '--1', '1; DROP TABLE posts', '1\n']) {
      expect(() => signedAmount('Post.increment', amount, 1)).toThrow(`got ${JSON.stringify(amount)}`)
    }
  })

  test('should refuse a value of any other type, naming the caller', () => {
    for (const amount of [null, true, {}, [1]]) {
      expect(() => signedAmount('Post.increment', amount, 1)).toThrow('Post.increment() takes a finite number')
    }
  })
})

describe('DECIMAL_LITERAL', () => {
  test('should admit only digits with an optional sign and fraction', () => {
    expect(['0', '-1', '10.50', '-0.01'].every((amount) => DECIMAL_LITERAL.test(amount))).toBe(true)
  })
})
