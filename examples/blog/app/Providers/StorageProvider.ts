import { ServiceProvider, createStorageManager } from '@guren/core'

export default class StorageProvider extends ServiceProvider {
  register(): void {
    this.container.instance('storage', createStorageManager({
      default: 'local',
      disks: {
        local: { driver: 'local', root: './storage/app' },
        // Rooted inside public/ so the root asset server serves these files
        // and disk.url() returns a URL that actually resolves.
        public: { driver: 'local', root: './public/storage', url: '/storage', visibility: 'public' },
      },
    }))
  }
}
