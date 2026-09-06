/**
 * Imported first by every test file, and deliberately import-free: it has to
 * set the environment before `src/app.ts`'s module graph evaluates.
 *
 * The database path is assigned, never defaulted: `tests/support/app.ts`
 * deletes the file it names, and Bun loads `.env` for `bun test` too — so
 * yielding to an ambient value would delete the developer's `data/agents.db`.
 */
process.env.SQLITE_DATABASE_PATH = new URL('../data/test.db', import.meta.url).pathname
process.env.APP_KEY ??= 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
