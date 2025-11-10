import type { ApplicationContext, Provider } from '@guren/server'
import { bootModels } from '../../config/app.js'

export default class DatabaseProvider implements Provider {
  private initialized = false

  async boot(_context: ApplicationContext): Promise<void> {
    if (this.initialized) {
      return
    }

    await bootModels()
    this.initialized = true
  }
}
