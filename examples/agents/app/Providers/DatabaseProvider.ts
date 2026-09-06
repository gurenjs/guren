import { ServiceProvider } from '@guren/core'

import { bootModels } from '../../config/app'

export default class DatabaseProvider extends ServiceProvider {
  register(): void {}

  async boot(): Promise<void> {
    await bootModels()
  }
}
