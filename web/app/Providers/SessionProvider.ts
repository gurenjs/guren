import { createSessionManager, ServiceProvider } from '@guren/core'
import { sessionConfig } from '../../config/session.js'

export default class SessionProvider extends ServiceProvider {
  // register(), not boot(): AuthServiceProvider builds the session middleware
  // around this binding at boot, before any app provider's own boot runs.
  register(): void {
    this.container.instance('session', createSessionManager(sessionConfig))
  }
}
