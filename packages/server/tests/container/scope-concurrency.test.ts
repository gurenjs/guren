import { describe, expect, test } from 'bun:test'
import { Container } from '../../src/container/Container'

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

describe('concurrent container scopes', () => {
  for (const first of ['a', 'b'] as const) {
    test(`keeps instances isolated when ${first} finishes first`, async () => {
      const container = new Container()
      container.bind('value', () => ({}))
      const a = gate(), b = gate()
      const values: object[] = []
      const run = (index: number, wait: ReturnType<typeof gate>) => container.scopedAsync(async () => {
        const before = container.make<object>('value')
        values[index] = before
        await wait.promise
        expect(container.make<object>('value')).toBe(before)
      })
      const pendingA = run(0, a), pendingB = run(1, b)
      expect(values[0]).not.toBe(values[1])
      if (first === 'a') { a.open(); await pendingA; b.open() }
      else { b.open(); await pendingB; a.open() }
      await Promise.all([pendingA, pendingB])
      expect(container.make<object>('value')).not.toBe(values[0])
      expect(container.make<object>('value')).not.toBe(values[1])
    })
  }

  test('restores the parent scope after a rejected nested scope', async () => {
    const container = new Container()
    container.bind('value', () => ({}))
    await container.scopedAsync(async () => {
      const parent = container.make<object>('value')
      await expect(container.scopedAsync(async () => {
        await Promise.resolve()
        expect(container.make<object>('value')).not.toBe(parent)
        throw new Error('nested failure')
      })).rejects.toThrow('nested failure')
      expect(container.scoped(() => container.make<object>('value'))).not.toBe(parent)
      expect(container.make<object>('value')).toBe(parent)
    })
  })
})
