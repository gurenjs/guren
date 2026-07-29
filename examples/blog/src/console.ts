import { ConsoleKernel } from '@guren/core'
import PostStatsCommand from '../app/Console/Commands/PostStatsCommand.js'
import app from './app.js'

export const kernel = new ConsoleKernel({ container: app.container })

kernel.register(PostStatsCommand)
