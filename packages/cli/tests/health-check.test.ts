import { describe, expect, it, mock } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createTempWorkspace,
  createConsolaStub,
  runCliBinCaptured,
  writeWorkspaceFiles,
} from './helpers'

interface HealthReportJson {
  status: string
  checks: Array<{ name: string; message?: string }>
}

interface HealthCliRun {
  stderr: string
  exitCode: number
  /** Parsed stdout — the helper always passes `--json`. */
  report: HealthReportJson
}

/**
 * Run `health:check --json` and return its parsed report.
 *
 * A subprocess and not an in-process call because the paths under test end in
 * `process.exit(1)`, and the exit code is half of what they assert.
 * {@link runCliBinCaptured} owns the environment the child needs — without it
 * `JSON.parse` would succeed here while a user's own `--json` run returned a
 * document with three lines of English in front of it.
 */
async function runHealthCli(cwd: string, args: string[] = []): Promise<HealthCliRun> {
  const { stdout, stderr, exitCode } = await runCliBinCaptured(
    ['health:check', ...args, '--json'],
    cwd,
  )
  return { stderr, exitCode, report: JSON.parse(stdout) as HealthReportJson }
}

/**
 * A health file exporting `exportName`, for the loader to find or reject.
 *
 * One builder rather than a literal per test: the shape the loader recognizes
 * (`check` / `checkOnly` / `getCheckNames`) is what several of these tests are
 * about, and a copy that missed a new member would fail as "exports no health
 * manager" — a message pointing at the loader rather than at the stale fixture.
 */
function managerSource(
  exportName: string,
  options: { checkName?: string; omitChecks?: boolean } = {},
): string {
  const { checkName = 'ok', omitChecks = false } = options
  const reported = omitChecks ? '' : `, checks: [{ name: '${checkName}', status: 'healthy' }]`
  const empty = omitChecks ? '' : ', checks: []'

  return `export const ${exportName} = {
  async check() {
    return { status: 'healthy', timestamp: new Date()${reported} }
  },
  async checkOnly() {
    return { status: 'healthy', timestamp: new Date()${empty} }
  },
  getCheckNames() {
    return ['${checkName}']
  },
}
`
}

const consolaStub = createConsolaStub({ debug: mock(() => {}) })

await mock.module('consola', () => ({
  consola: consolaStub,
  default: consolaStub,
  createConsola: () => consolaStub,
  LogLevels: {},
}))

const { runHealthCheck } = await import('../src/health-check')

describe('runHealthCheck', () => {
  it('prints a basic report when no health manager is configured', async () => {
    const workspace = await createTempWorkspace('guren-cli-health-basic-')
    const logSpy = mock(() => {})
    const originalLog = console.log
    console.log = logSpy as typeof console.log

    try {
      await runHealthCheck({ appRoot: workspace.dir, json: true })
      expect(logSpy).toHaveBeenCalled()
    } finally {
      console.log = originalLog
      await workspace.cleanup()
    }
  })

  it('says the health file could not be read, rather than reporting none', async () => {
    // Spawned rather than called in-process: this path exits non-zero, which
    // is half of what is under test. A health file that exists and throws on
    // import used to arrive here as `null` — printed as "No health manager
    // found" with instructions to create the file the user already has, and
    // `--json` answered `"status": "healthy"` off the built-in memory/uptime
    // checks alone. An unreadable config is not a clean bill of health.
    const workspace = await createTempWorkspace('guren-cli-health-unreadable-')

    try {
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/health.ts'),
        "import 'a-package-that-is-not-installed'\nexport const health = {}\n",
        'utf8',
      )
      // Two candidate paths, one file. A case-insensitive filesystem produces
      // this on its own (`app/health.ts` and `app/Health.ts` are both probed),
      // but only a symlink reproduces it on ext4 — without one, the dedupe
      // could be deleted and this assertion would still see a single finding
      // everywhere CI runs.
      await symlink(join(workspace.dir, 'app/health.ts'), join(workspace.dir, 'src/health.ts'))

      const { stderr, exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(1)
      expect(stderr).toContain('Health checks could not be read')
      expect(stderr).not.toContain('No health manager found')

      expect(report.status).toBe('unhealthy')

      // One finding, not one per candidate path — see `fileIdentity`.
      const configChecks = report.checks.filter((check) => check.name === 'health-config')
      expect(configChecks).toHaveLength(1)
      // Which file, and why — the two things "No health manager found" never said.
      expect(configChecks[0]?.message).toContain('app/health.ts')
      expect(configChecks[0]?.message).toContain('a-package-that-is-not-installed')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports an explicit --health file that exports no manager', async () => {
    // `--health <path>` is the user naming the file, so anything that stops it
    // from yielding a manager is a failure — including a file that imports
    // cleanly and exports the wrong shape. It used to fall through to "No
    // health manager found" and answer `"status": "healthy"` off the built-in
    // memory and uptime checks, exit 0. The default candidate list is a
    // *search*, so a miss there is still silent.
    const workspace = await createTempWorkspace('guren-cli-health-wrong-shape-')

    try {
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(join(workspace.dir, 'config/health.ts'), 'export const health = {}\n', 'utf8')

      const { exitCode, report } = await runHealthCli(workspace.dir, ['--health', 'config/health.ts'])

      expect(exitCode).toBe(1)
      expect(report.status).toBe('unhealthy')
      expect(report.checks.find((check) => check.name === 'health-config')?.message)
        .toContain('exports no health manager')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a health file that exists only as a dangling symlink', async () => {
    // `existsSync` answers "no" for a dangling symlink, an untraversable
    // parent, and an `app` that is a regular file. Skipping the candidate on
    // any of those left `loadErrors` empty and the command answered
    // `"status": "healthy"` off the built-in checks — a clean bill of health
    // for a configuration it never managed to look at.
    const workspace = await createTempWorkspace('guren-cli-health-dangling-')

    try {
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await symlink(join(workspace.dir, 'app/nowhere.ts'), join(workspace.dir, 'app/health.ts'))

      const { exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(1)
      expect(report.status).toBe('unhealthy')
      // One finding, not one per candidate path: `realpath` cannot answer for
      // a dangling link, so this is the case `fileIdentity`'s inode fallback
      // exists for.
      expect(report.checks.filter((check) => check.name === 'health-config')).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('finds a manager that a placeholder export would have shadowed', async () => {
    // The export was picked by truthiness and only then tested for shape, so a
    // file carrying both a placeholder `health` and a real `healthManager` was
    // judged on the placeholder — reported as exporting no manager, and its
    // actual checks never ran.
    const workspace = await createTempWorkspace('guren-cli-health-shadowed-')

    try {
      await writeWorkspaceFiles(workspace.dir, {
        'app/health.ts': `export const health = {}\n${managerSource('healthManager', { checkName: 'real' })}`,
      })

      const { exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(0)
      // The configured check ran; the built-in fallbacks did not.
      expect(report.checks.map((check) => check.name)).toEqual(['real'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('treats --health with an empty value as no flag at all', async () => {
    // The mode switch and the path list read `options.health` differently —
    // `!== undefined` versus truthiness — so citty's `''` for a valued flag
    // given no value turned on named-file strictness while leaving the
    // default *search* in place. A candidate that merely exports no manager
    // then failed the command, on an app that passes without the flag.
    const workspace = await createTempWorkspace('guren-cli-health-empty-flag-')

    try {
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/health.ts'), 'export const health = {}\n', 'utf8')

      const run = async (args: string[]) => {
        const { exitCode, report } = await runHealthCli(workspace.dir, args)
        // Timestamps and uptime differ between two runs by construction, so
        // the comparison is over what the flag could actually change.
        return { exitCode, status: report.status, checks: report.checks.map((c) => c.name) }
      }

      // Asserted against the no-flag run rather than a literal: the point is
      // that an empty value names no file, so it cannot change the answer.
      // Concurrent because both are read-only against the same fixture.
      const [withEmptyFlag, withoutFlag] = await Promise.all([run(['--health=']), run([])])
      expect(withEmptyFlag).toEqual(withoutFlag)
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps an earlier load failure in the report when a later file works', async () => {
    // Only the "no manager at all" branch used to report `loadErrors`, so a
    // broken `app/health.ts` beside a working `src/health.ts` left over from
    // an older layout answered `"status": "healthy"` and exit 0 — the file the
    // operator configured never ran, and `--json` said nothing about it.
    const workspace = await createTempWorkspace('guren-cli-health-partial-')

    try {
      await writeWorkspaceFiles(workspace.dir, {
        'app/health.ts': "import 'a-package-that-is-not-installed'\nexport const health = {}\n",
        'src/health.ts': managerSource('health', { checkName: 'src-one' }),
      })

      const { exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(1)
      expect(report.status).toBe('unhealthy')
      // The working manager's checks still run and are still reported.
      expect(report.checks.map((check) => check.name)).toEqual(['health-config', 'src-one'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('survives a manager whose report omits checks', async () => {
    // The manager is app-authored and arrives through `import()`, so nothing
    // type-checks its report. Splicing the load failures into one that has no
    // `checks` spread `undefined` and killed the command — on exactly the path
    // that had a diagnostic to print, so the output was empty where it mattered
    // most. (`printReport` had the same hole for longer, on the non-json path.)
    const workspace = await createTempWorkspace('guren-cli-health-checkless-')

    try {
      await writeWorkspaceFiles(workspace.dir, {
        'app/health.ts': "import 'a-package-that-is-not-installed'\n",
        'src/health.ts': managerSource('health', { omitChecks: true }),
      })

      const { exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(1)
      expect(report.status).toBe('unhealthy')
      expect(report.checks.map((check) => check.name)).toEqual(['health-config'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('uses configured health checks when available', async () => {
    const workspace = await createTempWorkspace('guren-cli-health-config-')
    const logSpy = mock(() => {})
    const originalLog = console.log
    console.log = logSpy as typeof console.log

    try {
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/health.ts'),
        `
export const health = {
  async check() {
    return { status: 'healthy', timestamp: new Date(), checks: [] }
  },
  async checkOnly(names) {
    globalThis.__healthChecks = names
    return { status: 'healthy', timestamp: new Date(), checks: [] }
  },
  getCheckNames() {
    return ['db', 'cache']
  },
}
`,
        'utf8',
      )

      await runHealthCheck({ appRoot: workspace.dir, checks: 'db,cache', json: true })

      expect((globalThis as typeof globalThis & { __healthChecks?: string[] }).__healthChecks).toEqual(['db', 'cache'])
    } finally {
      delete (globalThis as typeof globalThis & { __healthChecks?: string[] }).__healthChecks
      console.log = originalLog
      await workspace.cleanup()
    }
  })
})
