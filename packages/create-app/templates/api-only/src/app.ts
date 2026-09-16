import { createApp } from '@guren/core'
import database from '../config/database.js'
import env from '../config/env.js'
import http from '../config/http.js'
import { registerApiRoutes } from '../routes/api.js'

const app = createApp({
  env,
  config: [database, http],
  routes: registerApiRoutes,
})

export default app
