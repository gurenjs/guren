import { AttachmentsPruneCommand, ConsoleKernel } from '@guren/core'
import PostStatsCommand from '../app/Console/Commands/PostStatsCommand.js'
import app from './app.js'
import { SessionsPruneCommand } from '@guren/core'

export const kernel = new ConsoleKernel({ container: app.container })

kernel.registerMany([PostStatsCommand, AttachmentsPruneCommand, SessionsPruneCommand])
