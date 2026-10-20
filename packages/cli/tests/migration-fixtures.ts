import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** drizzle-kit 1.x snapshot entries for `users(id, age)` and `posts(id, user_id)` with an ON DELETE CASCADE to users. */
function cascadeSnapshot(id: string, prevIds: string[]) {
  const column = (table: string, name: string, type: string) => ({ entityType: 'columns', table, name, type })
  return JSON.stringify({
    dialect: 'sqlite', id, prevIds,
    ddl: [
      column('users', 'id', 'integer'), column('users', 'age', 'text'), column('posts', 'id', 'integer'), column('posts', 'user_id', 'integer'),
      { entityType: 'fks', table: 'posts', columns: ['user_id'], tableTo: 'users', columnsTo: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
    ],
  })
}

const CASCADE_CREATE = [
  'CREATE TABLE `users` (`id` integer PRIMARY KEY, `age` text);',
  'CREATE TABLE `posts` (`id` integer PRIMARY KEY, `user_id` integer REFERENCES `users`(`id`) ON DELETE cascade);',
].join('\n--> statement-breakpoint\n')
const USERS_REBUILD = [
  'PRAGMA foreign_keys=OFF;',
  "CREATE TABLE `__new_users` (`id` integer PRIMARY KEY, `age` text DEFAULT '0');",
  'INSERT INTO `__new_users`(`id`, `age`) SELECT `id`, `age` FROM `users`;',
  'DROP TABLE `users`;',
  'ALTER TABLE `__new_users` RENAME TO `users`;',
  'PRAGMA foreign_keys=ON;',
].join('\n--> statement-breakpoint\n')

/** A rebuild of `users`, which `posts` references with ON DELETE CASCADE, after the create. */
export async function writeCascadeRebuild(cwd: string): Promise<void> {
  for (const [name, sql] of [['0001_create', CASCADE_CREATE], ['0002_default', USERS_REBUILD]] as const) {
    await mkdir(join(cwd, 'db/migrations', name), { recursive: true })
    await writeFile(join(cwd, 'db/migrations', name, 'migration.sql'), sql)
  }
  await writeFile(join(cwd, 'db/migrations/0001_create/snapshot.json'), cascadeSnapshot('a', []))
  await writeFile(join(cwd, 'db/migrations/0002_default/snapshot.json'), cascadeSnapshot('b', ['a']))
}
