/**
 * The `@deprecated` tag is only a deprecation where a user's editor sees it,
 * which is the built declarations, not these sources: `@guren/core` re-exports
 * `@guren/server` wholesale, so the tag reaches an app through the built file
 * the re-export resolves to.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER_DIST = join(import.meta.dir, '../../dist')
const CORE_DIST = join(import.meta.dir, '../../../core/dist')

/** Every deprecated symbol, with the declaration file it is emitted into. */
const DEPRECATED: Record<string, string[]> = {
  'authorization/Gate.d.ts': ['setGate', 'getGate'],
  'encryption/Encrypter.d.ts': ['setEncrypter', 'getEncrypter'],
  'mail/Mail.d.ts': ['setMailManager', 'getMailManager'],
  'queue/Job.d.ts': ['setQueueDriver', 'getQueueDriver'],
  'i18n/I18nManager.d.ts': ['setI18n', 'getI18n', 'tryGetI18n'],
  'logging/LogManager.d.ts': ['setLogManager', 'getLogManager'],
  'notifications/NotificationManager.d.ts': ['setNotificationManager', 'getNotificationManager'],
  'broadcasting/BroadcastManager.d.ts': ['setBroadcastManager', 'getBroadcastManager'],
  'errors/ExceptionHandler.d.ts': ['setExceptionHandler', 'getExceptionHandler'],
  'container/Container.d.ts': ['setContainer', 'getContainer'],
  'mvc/inertia/InertiaEngine.d.ts': ['setInertiaDocument', 'setInertiaSsrRenderer'],
  'mvc/inertia/shared.d.ts': ['setInertiaSharedProps', 'getInertiaSharedPropsResolver'],
}

function read(base: string, file: string): string {
  const path = join(base, file)
  if (!existsSync(path)) {
    throw new Error(`Expected ${path}; run \`bun run build server core\` before this test.`)
  }
  return readFileSync(path, 'utf8')
}

describe('the built declarations', () => {
  test.each(Object.entries(DEPRECATED))('carry @deprecated on %s', (file, symbols) => {
    const source = read(SERVER_DIST, file)
    for (const symbol of symbols) {
      const declaration = source.indexOf(`declare function ${symbol}`)
      expect(declaration).toBeGreaterThan(-1)
      // The doc block immediately above the declaration, not merely somewhere
      // in a file that deprecates one of its siblings.
      const block = source.slice(source.lastIndexOf('/**', declaration), declaration)
      expect(block).toContain('@deprecated')
    }
  })

  test("reach an app through @guren/core's re-export", () => {
    const index = read(CORE_DIST, 'index.d.ts')
    expect(index).toContain('export * from "@guren/server"')

    const serverIndex = read(SERVER_DIST, 'index.d.ts')
    for (const symbol of Object.values(DEPRECATED).flat()) {
      expect(serverIndex).toContain(symbol)
    }
  })
})
