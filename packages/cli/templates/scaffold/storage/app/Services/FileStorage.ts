import type { StorageManager } from '@guren/core'

export class FileStorage {
  constructor(private readonly storage: StorageManager) {}

  async writeHealthcheck(): Promise<void> {
    await this.storage.disk('public').put('health.txt', 'ok')
  }
}
