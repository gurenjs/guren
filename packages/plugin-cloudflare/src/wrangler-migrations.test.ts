import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flattenD1Migrations } from './build'

// Opt-in end-to-end contract test: verifies wrangler applies drizzle-kit
// generated SQL (tab indentation, backtick quoting, `--> statement-breakpoint`
// separators, 0000_-prefixed filename ordering) against a local D1 database.
// Requires network on first run (bunx downloads wrangler + workerd), so it is
// gated behind GUREN_TEST_WRANGLER=1 and skipped in CI.
const enabled = process.env.GUREN_TEST_WRANGLER === '1'

function wrangler(cwd: string, args: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync({
    cmd: ['bunx', 'wrangler', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  }
}

describe.skipIf(!enabled)('wrangler d1 migrations (drizzle-kit SQL contract)', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-wrangler-d1-'))
    mkdirSync(join(root, 'db/migrations/meta'), { recursive: true })

    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'guren-fmt-test',
        main: 'worker.js',
        compatibility_date: '2026-07-01',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'guren-fmt-test',
            database_id: '00000000-0000-0000-0000-000000000000',
            migrations_dir: 'd1-migrations',
          },
        ],
      }),
    )
    writeFileSync(join(root, 'worker.js'), 'export default { fetch() { return new Response("ok") } }\n')

    // Real drizzle-kit 1.x layout: one folder per migration containing
    // migration.sql — flattened for wrangler by flattenD1Migrations.
    mkdirSync(join(root, 'db/migrations/0000_bright_dawn'), { recursive: true })
    writeFileSync(
      join(root, 'db/migrations/0000_bright_dawn/migration.sql'),
      'CREATE TABLE `posts` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`title` text NOT NULL\n);\n--> statement-breakpoint\nCREATE INDEX `posts_title_idx` ON `posts` (`title`);\n',
    )
    mkdirSync(join(root, 'db/migrations/0001_calm_night'), { recursive: true })
    writeFileSync(
      join(root, 'db/migrations/0001_calm_night/migration.sql'),
      'ALTER TABLE `posts` ADD `slug` text;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `posts_slug_unique` ON `posts` (`slug`);\n',
    )
    writeFileSync(join(root, 'db/migrations/meta/_journal.json'), '{"version":"7","dialect":"sqlite","entries":[]}\n')
    flattenD1Migrations(join(root, 'db/migrations'), join(root, 'd1-migrations'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test(
    'should apply drizzle-kit SQL files in filename order and stay idempotent',
    () => {
      const apply = wrangler(root, ['d1', 'migrations', 'apply', 'DB', '--local'])
      expect(apply.exitCode).toBe(0)
      expect(apply.output).toContain('0000_bright_dawn.sql')
      expect(apply.output).toContain('0001_calm_night.sql')

      const reapply = wrangler(root, ['d1', 'migrations', 'apply', 'DB', '--local'])
      expect(reapply.exitCode).toBe(0)
      expect(reapply.output).toContain('No migrations to apply')
    },
    240_000,
  )

  test(
    'should produce a queryable schema including post-ALTER columns',
    () => {
      const query = wrangler(root, [
        'd1',
        'execute',
        'DB',
        '--local',
        '--json',
        '--command',
        "INSERT INTO posts (title, slug) VALUES ('hello', 'hello-slug'); SELECT title, slug FROM posts",
      ])
      expect(query.exitCode).toBe(0)
      expect(query.output).toContain('"hello-slug"')
    },
    240_000,
  )
})
