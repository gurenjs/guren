import { ServiceProvider } from '@guren/server'
import { bootModels } from '../../config/app.js'

export default class DatabaseProvider extends ServiceProvider {
  private initialized = false

  async boot(): Promise<void> {
    if (this.initialized) {
      return
    }

    await bootModels()
    this.initialized = true
  }

  register(): void {}
}
