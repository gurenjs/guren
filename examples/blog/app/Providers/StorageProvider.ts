import { ServiceProvider, createStorageManager } from '@guren/core'

export default class StorageProvider extends ServiceProvider {
  register(): void {
    this.container.instance('storage', createStorageManager({
      default: 'local',
      disks: {
        local: { driver: 'local', root: './storage/app' },
        public: { driver: 'local', root: './storage/app/public', visibility: 'public' },
      },
    }))
  }
}
