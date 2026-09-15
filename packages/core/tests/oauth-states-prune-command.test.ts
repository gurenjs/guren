import { describe, expect, test } from 'bun:test'
import { Container, OAuthStatesPruneCommand, createOAuthManager } from '../src/index'
import type { OAuthStateStore } from '@guren/server'
import { capturingOutput } from './console-output'

describe('oauth-states:prune', () => {
  test('sweeps the state store behind the oauth binding', async () => {
    const swept: Date[] = []
    const store: OAuthStateStore = {
      store: async () => {},
      find: async () => null,
      delete: async () => {},
      deleteExpired: async (now) => {
        swept.push(now)
      },
    }
    const container = new Container()
    container.instance('oauth', createOAuthManager({ stateStore: store }))
    const lines: string[] = []
    const command = new OAuthStatesPruneCommand(container)
    command.setOutput(capturingOutput(lines))

    await command.handle()

    expect(swept).toHaveLength(1)
    expect(lines.join('\n')).toContain('Expired OAuth states removed.')
  })

  // Exit 0 on a schedule nobody reads would report a sweep that never ran.
  test('throws when no provider binds an OAuth manager', async () => {
    const command = new OAuthStatesPruneCommand(new Container())

    await expect(command.handle()).rejects.toThrow(/requires an OAuth manager/)
  })
})
