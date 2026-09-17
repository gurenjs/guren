process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, test } from 'bun:test'
import { useAsDefaultApplication } from '@guren/core'

import { embed, embedMany, image, type AiManager } from '../src'
import { bootHarness } from './fixture'

describe('embed', () => {
  test('should call the default provider\'s embedding model through the manager', async () => {
    const h = await bootHarness()

    const result = await embed({ value: 'a ticket', manager: h.app.container.make<AiManager>('ai') })

    expect(result.embedding).toEqual([0, 0.5])
    expect(result.value).toBe('a ticket')
    expect(h.embeddings.doEmbedCalls[0]!.values).toEqual(['a ticket'])
  })

  test('should resolve the manager from the default application when none is passed', async () => {
    const h = await bootHarness()
    useAsDefaultApplication(h.app)

    const result = await embed({ value: 'ambient' })

    expect(result.embedding).toEqual([0, 0.5])
  })

  test('should pass the SDK\'s own options through', async () => {
    const h = await bootHarness()

    await embed({
      value: 'with options',
      headers: { 'x-trace': 'abc' },
      providerOptions: { fake: { dimensions: 2 } },
      manager: h.app.container.make<AiManager>('ai'),
    })

    const call = h.embeddings.doEmbedCalls[0]!
    expect(call.headers).toMatchObject({ 'x-trace': 'abc' })
    expect(call.providerOptions).toEqual({ fake: { dimensions: 2 } })
  })

  test('should refuse a provider name config/ai.ts does not configure', async () => {
    const h = await bootHarness()

    await expect(embed({ value: 'x', provider: 'mistral', manager: h.app.container.make<AiManager>('ai') }))
      .rejects.toThrow('No AI provider named "mistral" is configured')
  })

  test('should refuse a configured provider that declares no embeddingModel', async () => {
    const h = await bootHarness()

    await expect(embed({ value: 'x', provider: 'judge', manager: h.app.container.make<AiManager>('ai') }))
      .rejects.toThrow('The AI provider "judge" configures no embeddingModel in config/ai.ts.')
  })
})

describe('embedMany', () => {
  test('should embed every value in one call and keep their order', async () => {
    const h = await bootHarness()

    const result = await embedMany({
      values: ['first', 'second', 'third'],
      manager: h.app.container.make<AiManager>('ai'),
    })

    expect(result.embeddings).toEqual([[0, 0.5], [1, 0.5], [2, 0.5]])
    expect(result.values).toEqual(['first', 'second', 'third'])
    expect(h.embeddings.doEmbedCalls).toHaveLength(1)
  })
})

describe('image', () => {
  test('should generate through the default provider\'s image model', async () => {
    const h = await bootHarness()

    const result = await image({ prompt: 'a red fox', manager: h.app.container.make<AiManager>('ai') })

    expect(result.image.base64).toBe('image-0')
    expect(result.images).toHaveLength(1)
  })

  test('should pass n, size and the prompt to the model', async () => {
    const h = await bootHarness()

    const result = await image({
      prompt: 'a blue fox',
      n: 3,
      size: '512x512',
      manager: h.app.container.make<AiManager>('ai'),
    })

    expect(result.images.map((file) => file.base64)).toEqual(['image-0', 'image-1', 'image-2'])
  })

  test('should refuse a configured provider that declares no imageModel', async () => {
    const h = await bootHarness()

    await expect(image({ prompt: 'x', provider: 'judge', manager: h.app.container.make<AiManager>('ai') }))
      .rejects.toThrow('The AI provider "judge" configures no imageModel in config/ai.ts.')
  })
})
