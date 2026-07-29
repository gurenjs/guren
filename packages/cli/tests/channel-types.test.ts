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

  // Plugins used to be a fixed typescript+jsx pair for every extension. In a
  // `.ts` file that makes `<Type>value` cast syntax parse as an unterminated
  // JSX element, so the file silently contributed no channels at all.
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
