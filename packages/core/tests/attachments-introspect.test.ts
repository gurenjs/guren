import { afterEach, describe, expect, test } from 'bun:test'
import {
  configureAttachments,
  createApp,
  describeActiveAttachmentEngine,
  registerAttachmentRoutes,
  resetDefaultApplication,
  ServiceProvider,
  StorageManager,
  type AttachmentEngine,
} from '../src/index'
import { setActiveAttachmentEngine } from '../src/attachments/engine'
import { attachmentsTable } from './attachments-table'

afterEach(() => {
  setActiveAttachmentEngine(null)
  resetDefaultApplication()
})

function configure(): AttachmentEngine {
  return configureAttachments({
    table: attachmentsTable,
    storage: () => new StorageManager(),
    disk: 'media',
    disks: { media: 'public', vault: { visibility: 'private', serve: 'direct' } },
    delivery: { prefix: '/files/' },
    processor: null,
  }).engine
}

describe('attachments in the manifest (RFC 0026 §1)', () => {
  test('describeActiveAttachmentEngine() reports an unconfigured app, then the configured engine', () => {
    expect(describeActiveAttachmentEngine()).toEqual({ configured: false })

    configure()

    expect(describeActiveAttachmentEngine()).toEqual({
      configured: true,
      table: 'attachments',
      disk: 'media',
      disks: {
        media: { visibility: 'public', route: true, serve: 'auto' },
        vault: { visibility: 'private', route: false, serve: 'auto' },
      },
      delivery: { prefix: '/files', routeName: 'attachments.show' },
    })
  })

  test('an engine bound in register() becomes the manifest section, with whether its delivery route mounted', async () => {
    const engine = configure()
    class AttachmentsProvider extends ServiceProvider {
      register(): void {
        engine.bindTo(this.container)
      }
    }

    const mounted = await createApp({ providers: [AttachmentsProvider], routes: registerAttachmentRoutes }).introspect()
    const unmounted = await createApp({ providers: [AttachmentsProvider] }).introspect()

    expect(mounted.attachments).toMatchObject({ configured: true, table: 'attachments', delivery: { routeName: 'attachments.show', mounted: true } })
    expect(unmounted.attachments?.delivery?.mounted).toBe(false)
  })
})
