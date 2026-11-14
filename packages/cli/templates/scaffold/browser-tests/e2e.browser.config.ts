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
/** The runner refuses a shorter credential when it loads this file, for every command. */
const MIN_PASSWORD_LENGTH = 6
/** What the app's command inherits or the agent's adapter needs to start; never emptied below. */
const KEPT = new Set(['NODE_ENV', 'PATH', 'HOME'])

// The files Bun loads for the app, most specific first; the first file to set a name wins.
const mode = process.env.NODE_ENV || 'development'
const fromFiles = new Map<string, string>()
for (const file of ['.env.local', `.env.${mode}`, '.env']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (!match || KEPT.has(match[1]!) || fromFiles.has(match[1]!)) continue
    const raw = match[2]!.trim()
    const quoted = /^(['"`])(.*)\1$/u.exec(raw)
    fromFiles.set(match[1]!, quoted ? quoted[2]! : raw.replace(/\s+#.*$/u, ''))
  }
}

// One source for the browser account's password: the shell when it exports it, else the app's env files.
const password = process.env.BROWSER_TEST_PASSWORD || fromFiles.get('BROWSER_TEST_PASSWORD')

// Bun loads the app's env files into this process and again into the agent's adapter. Deleting a name
// here is not enough for the second load: an empty value is, since Bun's loader replaces no name already set.
for (const name of fromFiles.keys()) delete process.env[name]
delete process.env.BROWSER_TEST_PASSWORD
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
  ...(password && password.length >= MIN_PASSWORD_LENGTH ? { credentials: { browser: { username: BROWSER_ACCOUNT_EMAIL, password } } } : {}),
} satisfies E2EConfig
