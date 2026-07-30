import { ConsoleKernel } from '@guren/core'
import app from './app.js'

export const kernel = new ConsoleKernel({ container: app.container })

// `bunx guren make:command` adds the import and the array entry for you; the
// empty array literal is what it edits, so keep it even while unused.
// `bunx guren check` warns about any command class this file never registers.
kernel.registerMany([])
