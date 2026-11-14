import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
const BUN = process.versions.bun ? process.execPath : 'bun'

/**
 * What Bun loads from the app's env files under one NODE_ENV: a Bun started on nothing else holds exactly that.
 * Bun is asked because a parser written here would read some line differently, and a name it missed would
 * reach the agent with its value, while one it invented would empty a variable the shell set for the agent.
 */
async function envFilesUnder(mode: string): Promise<Record<string, string>> {
  const started = { NODE_ENV: mode, PATH: process.env.PATH || '', HOME: process.env.HOME || '' }
  try {
    const { stdout } = await promisify(execFile)(BUN, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: started, timeout: 30_000 })
    return Object.fromEntries(Object.entries(JSON.parse(stdout) as Record<string, string>).filter(([name]) => !KEPT.has(name)))
  } catch (error) {
    throw new Error('Could not ask Bun which names the app\'s env files set, so they cannot be kept from the agent.', { cause: error })
  }
}

// Bun picks the files by NODE_ENV and reads any value but production and test as development. All three are
// asked: an env file may itself set NODE_ENV, which hides from this process the mode Bun loaded it in.
const MODES = ['development', 'production', 'test']
const loaded = await Promise.all(MODES.map(envFilesUnder))
const fromFiles = loaded[Math.max(MODES.indexOf(process.env.NODE_ENV || ''), 0)]!

// One source for the browser account's password: the shell when it exports it, else the app's env files.
// Nothing is deleted from process.env: each worker loads this file again and has to read the same values.
const password = process.env.BROWSER_TEST_PASSWORD || fromFiles.BROWSER_TEST_PASSWORD

// Bun loads the app's env files into this process and again into the agent's adapter, and replaces no name
// already set. So each name goes to the agent as an empty string, over this process's value and the files'.
const emptied = Object.fromEntries([...loaded.flatMap((names) => Object.keys(names)), 'BROWSER_TEST_PASSWORD'].sort().map((name) => [name, '']))

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
