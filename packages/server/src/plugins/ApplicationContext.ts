import type { Hono } from 'hono'
import type { Application } from '../http/Application'
import { Route } from '../mvc/Route'
import { ViewEngine } from '../mvc/ViewEngine'
import type { AuthManager } from '../auth'

export class ApplicationContext {
  constructor(private readonly application: Application, private readonly authManager: AuthManager) {}

  get app(): Application {
    return this.application
  }

  get hono(): Hono {
    return this.application.hono
  }

  get routes(): typeof Route {
    return Route
  }

  get views(): typeof ViewEngine {
    return ViewEngine
  }

  get auth(): AuthManager {
    return this.authManager
  }
}
