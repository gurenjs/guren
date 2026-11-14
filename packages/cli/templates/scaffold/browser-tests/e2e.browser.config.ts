import { existsSync, readFileSync } from 'node:fs'
import type { E2EConfig } from 'e2e'
import { claudeCode } from '@e2e-dev/acp'
import { web } from '@e2e-dev/web'

/** Away from the dev server's port and the Playwright specs' (4317), so a run meets neither. */
const PORT = 4319
/**
 * The app's default locale, which plan labels are written in; sent as Accept-Language, which the server reads after the query and a cookie.
 * `guren add browser-tests --behaviours` wrote it from createApp({ i18n }); change it with the app's `fallback`.
 */
const LOCALE = 'en'
/** The account db/seeders/browser-account.ts writes while `guren browser:serve` runs the app. */
const BROWSER_ACCOUNT_EMAIL = 'browser@example.test'
/** In code points. The runner refuses a shorter credential when it loads this file, for every command. */
const MIN_PASSWORD_LENGTH = 6
/** Never handed to the agent empty: its adapter starts on PATH and HOME, NODE_ENV is no secret, and the executor sets ANTHROPIC_MODEL itself. */
const KEPT = new Set(['PATH', 'HOME', 'NODE_ENV', 'ANTHROPIC_MODEL'])

// Bun picks the app's env files by NODE_ENV, and reads any value but these two as development.
const mode = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test' ? process.env.NODE_ENV : 'development'
// The files Bun loads for the app, most specific first, then every other mode's, whose names count too.
const ENV_FILES = [
  `.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env',
  ...['development', 'production', 'test'].filter((other) => other !== mode).flatMap((other) => [`.env.${other}.local`, `.env.${other}`]),
  ...(mode === 'test' ? ['.env.local'] : []),
]
const fromFiles = new Map<string, string>()
for (const file of ENV_FILES) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    // The keys Bun accepts, `KEY: value` included. A line of a multi-line value may add a name nothing reads.
    const match = /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/u.exec(line)
    if (!match || KEPT.has(match[1]!) || fromFiles.has(match[1]!)) continue
    const raw = match[2]!.trim()
    const quoted = /^(['"`])(.*)\1$/u.exec(raw)
    fromFiles.set(match[1]!, quoted ? quoted[2]! : raw.replace(/\s+#.*$/u, ''))
  }
}

// One source for the browser account's password: the shell when it exports it, else the app's env files.
// Nothing is deleted from process.env: each worker loads this file again and has to read the same values.
const password = process.env.BROWSER_TEST_PASSWORD || fromFiles.get('BROWSER_TEST_PASSWORD')

// Bun loads the app's env files into this process and again into the agent's adapter, and replaces no name
// already set. So each name goes to the agent as an empty string, over this process's value and the files'.
const emptied = Object.fromEntries([...fromFiles.keys(), 'BROWSER_TEST_PASSWORD'].map((name) => [name, '']))

export default {
  tests: 'tests/browser/behaviours/**/*.e2e.ts',
  targets: [{
    engine: web({ locale: LOCALE }),
    app: {
      url: `http://127.0.0.1:${PORT}`,
      command: {
        // browser:serve refuses production and a database it cannot show is local, and stops only the app it started.
        executable: 'bunx',
        args: ['guren', 'browser:serve', '--port', String(PORT)],
        reuseExisting: false,
        startupTimeout: 150_000,
        // The command gets PATH, HOME and these names only. An app that picks its database from the shell adds the name here.
        inheritEnv: ['NODE_ENV'],
        // The seeder hashes this value and the runner types it, so the two cannot differ.
        ...(password ? { env: { BROWSER_TEST_PASSWORD: password } } : {}),
        log: '.e2e/logs/app.log',
      },
    },
  }],
  // Steps run under this machine's Claude Code login; a recorded step replays with no model call.
  agents: { default: { executor: claudeCode({ model: 'sonnet', env: emptied }) } },
  // Unset or too short, no credential is registered and the sign-in setup fails naming the variable.
  ...(password && [...password].length >= MIN_PASSWORD_LENGTH ? { credentials: { browser: { username: BROWSER_ACCOUNT_EMAIL, password } } } : {}),
} satisfies E2EConfig
