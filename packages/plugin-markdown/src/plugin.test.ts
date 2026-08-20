import { describe, test, expect } from 'bun:test'
import { Container, ProviderManager, type ServiceProviderConstructor } from '@guren/core'

import { markdownPlugin, type MarkdownRenderer } from './plugin'

async function bootWith(providers: ServiceProviderConstructor[]) {
  const container = new Container()
  const manager = new ProviderManager(container)
  manager.registerMany(providers)
  await manager.registerAll()
  await manager.bootAll()
  return container
}

describe('markdownPlugin', () => {
  test('should return an independent provider class per call', () => {
    const first = markdownPlugin()
    const second = markdownPlugin({})

    expect(typeof first).toBe('function')
    expect(first).not.toBe(second)
    expect(first.name).toBe('markdownPluginProvider')
  })

  test('should resolve a working renderer from the container', async () => {
    const container = await bootWith([markdownPlugin()])

    const renderer = container.make<MarkdownRenderer>('markdown')
    expect(await renderer.render('# Hi')).toBe('<h1 id="hi">Hi</h1>\n')
  })

  test('should capture configuration per registration', async () => {
    const container = await bootWith([markdownPlugin({ anchors: false })])

    const renderer = container.make<MarkdownRenderer>('markdown')
    expect(await renderer.render('# Hi')).toBe('<h1>Hi</h1>\n')
  })
})
