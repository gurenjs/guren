import { describe, test, expect } from 'bun:test'

import { inferBindings } from './inference'

describe('inferBindings', () => {
  test('should take the R2 bindings disks name, the D1 binding, and the disks it cannot see into', () => {
    const inferred = inferBindings({
      status: 'read',
      storage: {
        default: 'media',
        entries: {
          media: { driver: 'r2', binding: 'MEDIA' },
          avatars: { driver: 'r2', binding: 'MEDIA' },
          local: { driver: 'local' },
          vault: { driver: null },
          avatars2: { driver: 'r2' },
        },
      },
      database: { dialect: 'd1', location: 'unknown', binding: 'DB' },
    })

    expect(inferred).toEqual({ r2Buckets: ['MEDIA'], opaqueDisks: ['avatars2', 'vault'], databaseBinding: 'DB' })
  })

  test('should record why nothing was inferred, and ignore a binding on another dialect', () => {
    expect(inferBindings({ status: 'unread', reason: 'introspection failed with import' })).toEqual({ r2Buckets: [], unread: 'introspection failed with import' })
    expect(inferBindings({ status: 'read', database: { dialect: 'sqlite', location: 'local', binding: 'DB' } })).toEqual({ r2Buckets: [] })
  })
})
