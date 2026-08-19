import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { CLI_BIN_PATH, SERVER_DIST_ENTRY, assertWorkspaceBuilt, createTempWorkspace } from './helpers'

/**
 * Spawn the real bin: `bin.ts` exports nothing and builds its commands at
 * module scope, so the citty declaration under test — whether `entity` is a
 * positional or a string — is only observable through a subprocess.
 *
 * Exit code alone cannot tell the two apart here: `context --entity User`
 * exited 0 before this was fixed too, just having printed the whole-project
 * map. The assertions read stdout for that reason.
 */
async function runBin(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])

  const proc = Bun.spawn(['bun', CLI_BIN_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { exitCode, stdout }
}

/** The smallest workspace `guren context` resolves one model from. */
async function writeModelFixture(dir: string): Promise<void> {
  await mkdir(join(dir, 'app/Models'), { recursive: true })
  await mkdir(join(dir, 'db'), { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}', 'utf8')
  await writeFile(
    join(dir, 'db/schema.ts'),
    `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id'),
  email: text('email'),
})
`,
    'utf8',
  )
  await writeFile(
    join(dir, 'app/Models/User.ts'),
    `import { defineModel } from '@guren/orm'
import { users } from '../../db/schema.js'

export class User extends defineModel(users) {}
`,
    'utf8',
  )
}

describe('context entity argument', () => {
  it('resolves the entity from a positional argument', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-positional-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context', 'User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('# User')
      expect(stdout).toContain('## Model — app/Models/User.ts')
      expect(stdout).not.toContain('# Project Context')
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves the entity from --entity, which citty used to drop silently', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-flag-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context', '--entity', 'User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('# User')
      expect(stdout).toContain('## Model — app/Models/User.ts')
      // The regression: an `entity` declared `type: 'positional'` swallowed the
      // flag's value entirely, so this printed the whole-project map instead.
      expect(stdout).not.toContain('# Project Context')
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves the entity from --entity=<name>', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-flag-eq-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context', '--entity=User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('# User')
      expect(stdout).toContain('## Model — app/Models/User.ts')
      expect(stdout).not.toContain('# Project Context')
    } finally {
      await workspace.cleanup()
    }
  })

  it('still prints the project map when no entity is given', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-none-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('# Project Context')
      expect(stdout).not.toContain('## Model — app/Models/User.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps the positional working alongside --module', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-module-')
    try {
      await writeModelFixture(workspace.dir)

      const { exitCode, stdout } = await runBin(['context', '--module', 'app', 'User'], workspace.dir)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('## Model — app/Models/User.ts')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('queue:retry id argument', () => {
  // `id` stays positional (see bin.ts). This pins the reason: the flag spelling
  // is refused loudly rather than silently retrying the wrong thing, so it does
  // not need `context`'s treatment. If someone converts `id` to a `string`,
  // this test tells them the behavior it was protecting.
  it('refuses --id rather than silently retrying nothing', async () => {
    const workspace = await createTempWorkspace('guren-cli-queue-retry-flag-')
    try {
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const { exitCode } = await runBin(['queue:retry', '--id', '42'], workspace.dir)

      expect(exitCode).toBe(1)
    } finally {
      await workspace.cleanup()
    }
  })
})
