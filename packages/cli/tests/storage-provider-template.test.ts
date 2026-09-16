import { describe, expect, it } from 'bun:test'
import { Container, LocalStorageDriver, type AppEnv, type ConfigDefinition } from '@guren/core'

import StorageProvider from '../templates/scaffold/storage/app/Providers/StorageProvider'

// Through a variable: a static import pulls the template into the root typecheck,
// where no config/env.ts declares the key it reads.
const definitionPath = '../templates/scaffold/storage/config/storage.ts'
const storageConfig = ((await import(definitionPath)) as { default: ConfigDefinition<'storage'> }).default

// The templates themselves, not renders of them: scaffold-output.test.ts pins every
// blueprint's written file byte-identical to these sources.
describe('scaffolded storage under bun test', () => {
  it('roots the provider local disk under storage/app/testing, away from the development uploads', () => {
    expect(process.env.NODE_ENV).toBe('test')

    const container = new Container()
    new StorageProvider(container).register()

    const local = container.make('storage').disk('local')
    expect(local).toBeInstanceOf(LocalStorageDriver)
    expect((local as LocalStorageDriver).getRoot()).toBe('./storage/app/testing')
  })

  it('roots the definition local disk under storage/app/testing too', () => {
    const container = new Container()
    storageConfig.bind(container, storageConfig.resolve({ STORAGE_DISK: 'local' } as AppEnv))

    const local = container.make('storage').disk()
    expect(local).toBeInstanceOf(LocalStorageDriver)
    expect((local as LocalStorageDriver).getRoot()).toBe('./storage/app/testing')
  })

  it('refuses a STORAGE_DISK the definition does not declare at resolve, not at first upload', () => {
    expect(() => storageConfig.resolve({ STORAGE_DISK: 's3' } as AppEnv)).toThrow('STORAGE_DISK="s3" is not a declared disk')
  })
})
