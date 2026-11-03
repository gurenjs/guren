import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { buildChannelModuleContent, generateChannelTypes } from '../src/channel-types'

describe('buildChannelModuleContent', () => {
  it('emits channel pattern and event typings', () => {
    const definitions = new Map([
      ['announcements', { channel: 'announcements', events: new Map([['NewPost', new Set(['{ id: number }'])]]) }],
      ['private-posts.{id}', { channel: 'private-posts.{id}', events: new Map([['PostUpdated', new Set(['{ id: number }'])]]) }],
    ])

    const content = buildChannelModuleContent(definitions, { source: 'app' })

    expect(content).toContain("export const channelPatterns = [")
    expect(content).toContain("'announcements'")
    expect(content).toContain("'private-posts.{id}'")
    expect(content).toContain("export type ChannelName =")
    expect(content).toContain("'announcements'")
    expect(content).toContain("`private-posts.${string}`")
    expect(content).toContain("'NewPost': { id: number }")
    expect(content).toContain("'PostUpdated': { id: number }")
  })
})

describe('generateChannelTypes', () => {
  it('reads broadcastEvent(new X(…)) through the event class, declared in another file (RFC 0037)', async () => {
    const workspace = await createTempWorkspace('guren-cli-channel-types-')
    try {
      await mkdir(join(workspace.dir, 'app/Events'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/OrderController.ts'),
        `export async function ship(broadcast: any, order: { id: number }) {
  await broadcast.broadcastEvent(new OrderShipped(order.id))
  await broadcast.broadcastEvent(new Pinged())
  await broadcast.broadcastEvent(new Computed())
}
`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Events/OrderShipped.ts'),
        `export class OrderShipped {
  static eventName = 'order.shipped'
  constructor(readonly orderId: number) {}
  broadcastOn(): string[] {
    return [\`private-orders.\${this.orderId}\`, 'shipments']
  }
  broadcastWith() {
    return { carrier: 'post' }
  }
}

export class Pinged {
  broadcastOn() {
    return ['pings']
  }
}

export class Computed {
  broadcastOn() {
    return this.channels()
  }
}
`,
        'utf8',
      )

      const { outputPath, channels } = await generateChannelTypes({ appRoot: workspace.dir, force: true })

      expect(channels).toEqual(['pings', 'private-orders.{orderId}', 'shipments'])
      const content = await readFile(outputPath, 'utf8')
      expect(content).toContain("'order.shipped': { carrier: string }")
      expect(content).toContain("'Pinged': unknown")
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads the class an aliased import names, the name broadcastNameOf() sends, and skips a conditional broadcastOn()', async () => {
    const workspace = await createTempWorkspace('guren-cli-channel-types-')
    try {
      await mkdir(join(workspace.dir, 'app/Events'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/ship.ts'),
        `import { OrderShipped as Shipped, Branching } from './Events/OrderShipped'
export async function ship(broadcast: any) {
  await broadcast.broadcastEvent(new Shipped())
  await broadcast.broadcastEvent(new Branching())
}
`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Events/OrderShipped.ts'),
        `class OrderEvent {
  get eventName() { return 'order.instance' }
}

export class OrderShipped extends OrderEvent {
  static eventName = 'order.static'
  broadcastOn() { return ['shipments'] }
}

export class Branching {
  static eventName = 'branching'
  constructor(readonly hidden = false) {}
  broadcastOn() {
    if (this.hidden) return ['private-branching']
    return ['branching']
  }
}
`,
        'utf8',
      )

      const { outputPath, channels } = await generateChannelTypes({ appRoot: workspace.dir, force: true })

      expect(channels).toEqual(['shipments'])
      expect(await readFile(outputPath, 'utf8')).toContain("'order.instance': unknown")
    } finally {
      await workspace.cleanup()
    }
  })

  it('collects channels and events from providers and broadcast calls', async () => {
    const workspace = await createTempWorkspace('guren-cli-channel-types-')
    try {
      await mkdir(join(workspace.dir, 'app/Providers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Providers/BroadcastProvider.ts'),
        `export function setup(broadcast: any) {
  broadcast.channel('announcements', () => true)
  broadcast.privateChannel('posts.{id}', () => true)
  broadcast.toPrivate('posts.1').broadcast('PostUpdated', { id: 1 })
  broadcast.broadcast('announcements', 'NewPost', { id: 1 })
  broadcast.broadcast('announcements', 'Summary', 'hello')
  broadcast.broadcast('announcements', 'Counters', [1, 2, 3])
}
`,
        'utf8',
      )

      const { outputPath, channels } = await generateChannelTypes({
        appRoot: workspace.dir,
        force: true,
      })

      expect(channels).toContain('announcements')
      expect(channels).toContain('private-posts.{id}')
      expect(channels).toContain('private-posts.1')

      const content = await readFile(outputPath, 'utf8')
      expect(content).toContain("'announcements'")
      expect(content).toContain("'private-posts.{id}'")
      expect(content).toContain("'private-posts.1'")
      expect(content).toContain("'NewPost': { id: number }")
      expect(content).toContain("'PostUpdated': { id: number }")
      expect(content).toContain("'Summary': string")
      expect(content).toContain("'Counters': (number)[]")
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads a channel and event name written behind a transparent wrapper', async () => {
    const workspace = await createTempWorkspace('guren-cli-channel-types-wrapped-name-')
    try {
      await mkdir(join(workspace.dir, 'app/Providers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Providers/BroadcastProvider.ts'),
        `export function setup(broadcast: any) {
  broadcast.channel('announcements' as const, () => true)
  broadcast.broadcast('announcements' as const, 'NewPost' as const, { id: 1 })
}
`,
        'utf8',
      )

      const { channels, outputPath } = await generateChannelTypes({ appRoot: workspace.dir, force: true })

      // A wrapped name read as no name drops the whole channel, not just its payload.
      expect(channels).toContain('announcements')
      expect(await readFile(outputPath, 'utf8')).toContain("'NewPost': { id: number }")
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads a payload written behind a transparent wrapper', async () => {
    const workspace = await createTempWorkspace('guren-cli-channel-types-wrapped-')
    try {
      await mkdir(join(workspace.dir, 'app/Providers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Providers/BroadcastProvider.ts'),
        `export function setup(broadcast: any) {
  broadcast.channel('announcements', () => true)
  broadcast.broadcast('announcements', 'NewPost', { id: 1, tags: ['a'] as const } as const)
  broadcast.broadcast('announcements', 'Summary', 'hello' satisfies string)
}
`,
        'utf8',
      )

      const { outputPath } = await generateChannelTypes({ appRoot: workspace.dir, force: true })
      const content = await readFile(outputPath, 'utf8')

      expect(content).toContain("'NewPost': { id: number; tags: (string)[] }")
      expect(content).toContain("'Summary': string")
    } finally {
      await workspace.cleanup()
    }
  })

  // With the jsx plugin on, `<Type>value` in a `.ts` file parses as an
  // unterminated JSX element and the file silently contributes no channels.
  it('collects channels from a .ts file using angle-bracket type assertions', async () => {
    const workspace = await createTempWorkspace('guren-cli-channel-types-cast-')
    try {
      await mkdir(join(workspace.dir, 'app/Providers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Providers/BroadcastProvider.ts'),
        `export function setup(broadcast: any, raw: unknown) {
  const id = <number>raw
  broadcast.channel('announcements', () => true)
  broadcast.broadcast('announcements', 'NewPost', { id: 1 })
  return id
}
`,
        'utf8',
      )

      const { channels } = await generateChannelTypes({ appRoot: workspace.dir, force: true })
      expect(channels).toContain('announcements')
    } finally {
      await workspace.cleanup()
    }
  })

  it('collects channels from a decorated provider class', async () => {
    const workspace = await createTempWorkspace('guren-cli-channel-types-decorators-')
    try {
      await mkdir(join(workspace.dir, 'app/Providers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Providers/BroadcastProvider.ts'),
        `@Injectable()
export class BroadcastProvider {
  @log accessor registered = false

  boot(broadcast: any) {
    broadcast.channel('announcements', () => true)
    broadcast.broadcast('announcements', 'NewPost', { id: 1 })
  }
}
`,
        'utf8',
      )

      const { channels } = await generateChannelTypes({ appRoot: workspace.dir, force: true })
      expect(channels).toContain('announcements')
    } finally {
      await workspace.cleanup()
    }
  })
})
