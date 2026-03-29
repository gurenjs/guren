import type { WriterOptions } from './utils'
import { kebabCase, scaffoldFile } from './utils'

const CHANNELS_DIR = 'app/Broadcasting'

function channelTemplate(className: string, channelName: string, isPrivate: boolean, isPresence: boolean): string {
  const baseClass = isPresence ? 'PresenceChannel' : isPrivate ? 'PrivateChannel' : 'Channel'

  if (isPresence) {
    return `import { PresenceChannel, type BroadcastManager, type Context } from '@guren/core'

export default class ${className} extends PresenceChannel {
  constructor(manager: BroadcastManager) {
    super('${channelName}', manager.driver())
  }

  async join(ctx: Context): Promise<{ id: string; name?: string } | false> {
    const user = ctx.get('user')
    if (!user) return false

    return {
      id: String(user.id),
      name: user.name,
    }
  }
}
`
  }

  if (isPrivate) {
    return `import { PrivateChannel, type BroadcastManager, type Context } from '@guren/core'

export default class ${className} extends PrivateChannel {
  constructor(manager: BroadcastManager) {
    super('${channelName}', manager.driver())
  }

  async authorize(ctx: Context): Promise<boolean> {
    const user = ctx.get('user')
    return !!user
  }
}
`
  }

  return `import { Channel, type BroadcastManager } from '@guren/core'

export default class ${className} extends Channel {
  constructor(manager: BroadcastManager) {
    super('${channelName}', manager.driver())
  }
}
`
}

export interface MakeChannelOptions extends WriterOptions {
  channel?: string
  private?: boolean
  presence?: boolean
}

export async function makeChannel(name: string, options: MakeChannelOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: CHANNELS_DIR,
    suffix: 'Channel',
    template: ({ normalizedName }) => {
      const channelName = options.channel ?? kebabCase(normalizedName.replace(/Channel$/, ''))
      return channelTemplate(normalizedName, channelName, options.private ?? false, options.presence ?? false)
    },
  }, options)
}
