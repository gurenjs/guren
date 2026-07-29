import { ConsoleKernel } from '@guren/core'
import app from './app.js'

export const kernel = new ConsoleKernel({ container: app.container })

// Register the classes `bunx guren make:command` writes to app/Console/Commands:
//
//   import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'
//   kernel.register(SendDigestCommand)
