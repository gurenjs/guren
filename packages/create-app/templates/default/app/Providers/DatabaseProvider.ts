import { ServiceProvider } from '@guren/core'
import { bootModels } from '../../config/app.js'

export default class DatabaseProvider extends ServiceProvider {
  private initialized = false

  register(): void {}

  async boot(): Promise<void> {
    if (this.initialized) {
      return
    }

    await bootModels()
    this.initialized = true
  }
}
