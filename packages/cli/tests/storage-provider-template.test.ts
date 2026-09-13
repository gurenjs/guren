import { describe, expect, it } from 'bun:test'
import { Container, LocalStorageDriver } from '@guren/core'

import StorageProvider from '../templates/scaffold/storage/app/Providers/StorageProvider'

// The template itself, not a render of it: scaffold-output.test.ts pins every
// blueprint's written file byte-identical to this source.
describe('scaffolded StorageProvider under bun test', () => {
  it('roots the local disk under storage/app/testing, away from the development uploads', () => {
    expect(process.env.NODE_ENV).toBe('test')

    const container = new Container()
    new StorageProvider(container).register()

    const local = container.make('storage').disk('local')
    expect(local).toBeInstanceOf(LocalStorageDriver)
    expect((local as LocalStorageDriver).getRoot()).toBe('./storage/app/testing')
  })
})
