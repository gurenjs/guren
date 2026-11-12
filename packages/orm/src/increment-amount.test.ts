import { describe, expect, test } from 'bun:test'
import { signedAmount } from './increment-amount'

describe('signedAmount', () => {
  test('should keep an amount as given for an increment', () => {
    expect(signedAmount('Post.increment', 2, false)).toBe(2)
    expect(signedAmount('Post.increment', 2n, false)).toBe(2n)
    expect(signedAmount('Post.increment', '10.50', false)).toBe('10.50')
    expect(signedAmount('Post.increment', '0', false)).toBe('0')
  })

  test('should negate each kind for a decrement', () => {
    expect(signedAmount('Post.decrement', 2, true)).toBe(-2)
    expect(signedAmount('Post.decrement', 2n, true)).toBe(-2n)
    expect(signedAmount('Post.decrement', '10.50', true)).toBe('-10.50')
    expect(signedAmount('Post.decrement', '-0.01', true)).toBe('0.01')
  })

  test('should refuse a number that is not finite', () => {
    expect(() => signedAmount('Post.increment', Number.NaN, false)).toThrow(TypeError)
    expect(() => signedAmount('Post.increment', Number.NEGATIVE_INFINITY, true)).toThrow(TypeError)
  })

  test('should refuse a string that is not one decimal literal, quoting it', () => {
    for (const amount of ['', '1e3', '1,5', ' 1', '1 ', '+1', '.5', '1.', '--1', '1; DROP TABLE posts', '1\n']) {
      expect(() => signedAmount('Post.increment', amount, false)).toThrow(`got ${JSON.stringify(amount)}`)
    }
  })

  test('should refuse a value of any other type, naming the caller', () => {
    for (const amount of [null, true, {}, [1]]) {
      expect(() => signedAmount('Post.increment', amount, false)).toThrow('Post.increment() takes a finite number')
    }
  })
})
