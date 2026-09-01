import { ServiceProvider, createStorageManager } from '@guren/core'

export default class StorageProvider extends ServiceProvider {
  register(): void {
    this.container.instance('storage', createStorageManager({
      default: 'local',
      disks: {
        local: { driver: 'local', root: './storage/app' },
        // Rooted inside public/ so the root asset server serves these files
        // and disk.url() returns a URL that actually resolves.
        //
        // For assets this app writes itself, then. Never for bytes someone
        // uploaded: anything on this disk is fetchable by URL with no
        // signature, no expiry and no authorization check. The framework
        // forces a download for document types served out of public/, so an
        // uploaded .svg will not execute on this origin — but that is a
        // backstop against one consequence, not access control, and
        // inlineDocuments: true opts out of it. Attachments go on `local`
        // above, handed out through the signed delivery route — see
        // config/attachments.ts.
        public: { driver: 'local', root: './public/storage', url: '/storage', visibility: 'public' },
      },
    }))
  }
}
