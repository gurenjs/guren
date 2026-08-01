import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { createTempWorkspace } from './helpers'

const CLI_BIN_PATH = resolve(import.meta.dir, '../src/bin.ts')

async function runCli(args: string[], cwd: string): Promise<{ exitCode: number }> {
  const proc = Bun.spawn(['bun', CLI_BIN_PATH, ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const exitCode = await proc.exited
  return { exitCode }
}

async function writeArchViolation(dir: string): Promise<void> {
  await writeFile(
    join(dir, 'guren.arch.ts'),
    `export default {
  layers: { domain: 'app/Domain/**', http: 'app/Http/**' },
  rules: [{ from: 'domain', disallow: ['http'] }],
}`,
    'utf8',
  )
  await mkdir(join(dir, 'app/Domain'), { recursive: true })
  await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
  await writeFile(join(dir, 'app/Http/Controllers/PostController.ts'), `export class PostController {}`, 'utf8')
  await writeFile(
    join(dir, 'app/Domain/OrderService.ts'),
    `import { PostController } from '../Http/Controllers/PostController'\nexport class OrderService {}`,
    'utf8',
  )
}

describe('guren check exit code', () => {
  it('plain `check` exits 0 even when arch violations are present (unchanged default behavior)', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-exitcode-default-')
    try {
      await writeArchViolation(workspace.dir)
      const { exitCode } = await runCli(['check', '--app', workspace.dir], workspace.dir)
      expect(exitCode).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  // The timestamptz rule is a core-suite warning by design: fixing an existing
  // column needs a migration whose USING clause is a human decision, so it
  // informs rather than gates.
  it('plain `check` exits 0 on an offset-less Postgres timestamp column', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-exitcode-timestamptz-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, timestamp } from 'drizzle-orm/pg-core'\nexport const posts = pgTable('posts', { createdAt: timestamp('created_at') })\n`,
        'utf8',
      )

      const { exitCode } = await runCli(['check', '--app', workspace.dir], workspace.dir)
      expect(exitCode).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('`check --arch` exits 1 when arch violations are present', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-exitcode-arch-')
    try {
      await writeArchViolation(workspace.dir)
      const { exitCode } = await runCli(['check', '--arch', '--app', workspace.dir], workspace.dir)
      expect(exitCode).toBe(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('`check --arch` exits 0 when there are no arch violations', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-exitcode-arch-clean-')
    try {
      await writeFile(
        join(workspace.dir, 'guren.arch.ts'),
        `export default { layers: { domain: 'app/Domain/**' }, rules: [{ from: 'domain', disallowPackages: ['drizzle-orm'] }] }`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Domain'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Domain/OrderService.ts'), `export class OrderService {}`, 'utf8')

      const { exitCode } = await runCli(['check', '--arch', '--app', workspace.dir], workspace.dir)
      expect(exitCode).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })
})
