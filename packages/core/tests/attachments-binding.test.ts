import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('the built declaration', () => {
  // `container.make('attachments')` types as the engine in an app only if this
  // augmentation survives into core's bundled .d.ts (RFC 0023 §1); core's own
  // sources see the source file, so nothing else would notice its loss.
  test('should carry the ServiceBindings attachments augmentation', () => {
    const declaration = join(import.meta.dir, '../dist/index.d.ts')
    if (!existsSync(declaration)) {
      throw new Error(`Expected ${declaration}; run \`bun run build core\` before this test.`)
    }

    const source = readFileSync(declaration, 'utf8')
    expect(source).toMatch(/interface ServiceBindings\s*\{[\s\S]*?attachments: AttachmentEngine/)
  })
})
