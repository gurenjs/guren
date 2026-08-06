import type { WriterOptions } from './utils'
import { kebabCase, scaffoldFile } from './utils'

const CHANNELS_DIR = 'app/Broadcasting'

/**
 * The body of a generated `authorize()`.
 *
 * A pattern carrying an `{id}` placeholder is per-user by convention, so the
 * default check ties the subscription to that user. Anything else can only
 * default to "any authenticated user" plus a TODO — the scaffolder cannot know
 * the ownership rule, and a check that silently allows everyone is the thing
 * this is meant to avoid.
 */
function privateAuthorize(channelName: string): { param: string; body: string } {
  if (channelName.includes('{id}')) {
    const ownerPattern = channelName.replace('{id}', '${(user as { id: string | number }).id}')

    return {
      param: 'channelName',
      body: `    if (!user) return false

    // \`${channelName}\` is per-user: only the owner may subscribe.
    return channelName === \`private-${ownerPattern}\``,
    }
  }

  return {
    param: '_channelName',
    body: `    // TODO: narrow this. Every authenticated user can subscribe as written.
    return user != null`,
  }
}

function channelTemplate(className: string, channelName: string, isPrivate: boolean, isPresence: boolean): string {
  if (isPresence) {
    return `import { PresenceChannel, type BroadcastManager, type PresenceMember } from '@guren/core'

export default class ${className} extends PresenceChannel {
  constructor(manager: BroadcastManager) {
    super('${channelName}', manager.driver())
  }

  /**
   * Decide who may join, and what the other members see.
   *
   * Return \`null\` to refuse. Register it so it runs:
   *   broadcast.presenceChannel(channel.getBaseName(), (name, user) => channel.authorizeJoin(name, user))
   *
   * Named apart from the inherited \`join(member)\`, which adds an already
   * authorized member to the channel.
   */
  async authorizeJoin(_channelName: string, user: unknown): Promise<PresenceMember | null> {
    if (!user) return null

    const member = user as { id: string | number; name?: string }
    return {
      id: member.id,
      info: { name: member.name },
    }
  }
}
`
  }

  if (isPrivate) {
    const { param, body } = privateAuthorize(channelName)

    return `import { PrivateChannel, type BroadcastManager } from '@guren/core'

export default class ${className} extends PrivateChannel {
  constructor(manager: BroadcastManager) {
    super('${channelName}', manager.driver())
  }

  /**
   * Decide who may subscribe. Register it so it runs:
   *   broadcast.privateChannel(channel.getBaseName(), (name, user) => channel.authorize(name, user))
   */
  async authorize(${param}: string, user: unknown): Promise<boolean> {
${body}
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
