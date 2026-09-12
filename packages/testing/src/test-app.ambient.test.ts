import { describe, expect, it } from 'vitest'
import { Application, resetDefaultApplication, resolve } from '@guren/server'
import { TestApp } from './test-app'

/** Warnings this file provokes, with the real `console.warn` restored either way. */
async function warningsDuring(run: () => Promise<void> | void): Promise<string[]> {
  const collected: string[] = []
  const warn = console.warn
  console.warn = (message: unknown) => collected.push(String(message))

  try {
    await run()
  } finally {
    console.warn = warn
  }

  return collected.filter((line) => line.includes('Two Applications exist'))
}

describe('TestApp and the ambient application (RFC 0023)', () => {
  it('does not read as rival live apps when a run creates several', async () => {
    resetDefaultApplication()

    const warnings = await warningsDuring(async () => {
      await TestApp.create({ routes: (router) => { router.get('/first', () => 'first') } })
      await TestApp.create({ routes: (router) => { router.get('/second', () => 'second') } })
      resolve('app')
    })

    expect(warnings).toEqual([])

    // The control: an app constructed beside the claim is what the warning is
    // for, so the assertion above can fail rather than merely finding silence.
    const provoked = await warningsDuring(() => {
      new Application()
      resolve('app')
    })

    expect(provoked).toHaveLength(1)
    resetDefaultApplication()
  })
})
