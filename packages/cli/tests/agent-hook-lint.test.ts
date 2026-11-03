import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { initGitRepo, linkOxlint, runAgentHook, shippedHookCommand, writeWorkspaceFiles } from './helpers'

// The edit hook (see runAgentHook for how it is driven). Most edited files sit
// outside the watched paths, so only oxlint runs; `guren check`'s rules are covered
// by their own tests, and the one case below that reaches it pins the output contract.
// The hook is handed the path the editor reports, which is absolute.

const template = resolve(import.meta.dir, '../templates/agent/targets/claude/hooks/check-after-edit.ts')
// A built-in rule keeps the test independent of which plugin the app configures.
const CONFIG = JSON.stringify({ rules: { 'no-debugger': 'warn' } })

type HookRun = Awaited<ReturnType<typeof runAgentHook>>

function runHook(
  app: (dir: string) => void | Promise<void>,
  editedFile: string,
  options: { installed?: boolean } = {},
): Promise<HookRun> {
  return runAgentHook(template, '.claude/hooks/check-after-edit.ts', { tool_input: { file_path: editedFile } }, async (dir) => {
    if (options.installed !== false) await linkOxlint(dir)
    await app(dir)
  })
}

/**
 * The context the hook hands Claude Code. Exit 0, and stdout holding one JSON object
 * and nothing else: any other text there makes Claude Code read it as plain text,
 * which a PostToolUse hook's agent never sees.
 */
function contextOf(result: HookRun): string {
  expect(result.exitCode).toBe(0)
  const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown } }
  expect(output.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
  const context = output.hookSpecificOutput?.additionalContext
  if (typeof context !== 'string') throw new Error(`additionalContext is not a string: ${result.stdout}`)
  return context
}

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

function expectSilent(result: HookRun): void {
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('')
}

const FLAGGED_FILE = 'debugger\nexport const a = 1\n'

describe('check-after-edit hook: oxlint', () => {
  test('hands findings on the edited file to the agent as context, warnings included, without blocking', async () => {
    const context = contextOf(await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE)
    }, 'lib.ts'))

    expect(context).toContain('After editing lib.ts:')
    expect(context).toContain('oxlint found 1 issue(s)')
    expect(context).toContain('lib.ts:1:1:')
    expect(context).toContain('eslint(no-debugger)')
    expect(context).toContain('do not block the edit')
    expect(context).toContain('`guren gate`')
  })

  test('stays quiet without an .oxlintrc.json, and on a clean file', async () => {
    expectSilent(await runHook((dir) => writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE), 'lib.ts'))
    expectSilent(await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n')
    }, 'lib.ts'))
  })

  test('a config that fails to load is reported, not read as clean', async () => {
    const context = contextOf(await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ jsPlugins: ['./missing-plugin.js'] }))
      writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE)
    }, 'lib.ts'))

    expect(context).toContain('without linting lib.ts')
  })

  test('a file the config ignores is not a failure', async () => {
    expectSilent(await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ignorePatterns: ['gen/**'], rules: { 'no-debugger': 'warn' } }))
      mkdirSync(join(dir, 'gen'))
      writeFileSync(join(dir, 'gen', 'x.ts'), FLAGGED_FILE)
    }, 'gen/x.ts'))
  })

  test('a config without an installed oxlint asks for bun install', async () => {
    const context = contextOf(await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE)
    }, 'lib.ts', { installed: false }))

    expect(context).toContain('run `bun install`')
  })

  test('skips generated and non-source paths', async () => {
    expectSilent(await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      mkdirSync(join(dir, '.guren'))
      writeFileSync(join(dir, '.guren', 'routes.gen.ts'), FLAGGED_FILE)
    }, '.guren/routes.gen.ts'))
  })

  // 400 findings run to about 30,000 characters; Claude Code inlines 10,000.
  test('cuts a long list below the context cap and says where the rest is', async () => {
    const context = contextOf(await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      writeFileSync(join(dir, 'lib.ts'), `${'debugger\n'.repeat(400)}export const a = 1\n`)
    }, 'lib.ts'))

    expect(context.length).toBeLessThan(10_000)
    expect(context).toContain('oxlint found 400 issue(s)')
    expect(context).toContain('The list is cut here')
    expect(context).not.toContain('lib.ts:400:1:')
    expect(context).toContain('do not block the edit')
  })

  describe('in a git repository', () => {
    const app = (dir: string) => {
      initGitRepo(dir)
      writeFileSync(join(dir, '.gitignore'), 'scratch/\n')
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      mkdirSync(join(dir, 'scratch'))
      writeFileSync(join(dir, 'scratch', 'eval.ts'), FLAGGED_FILE)
      writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE)
    }

    test('skips a file git ignores', async () => {
      expectSilent(await runHook(app, 'scratch/eval.ts'))
    })

    test('still checks an untracked file git does not ignore', async () => {
      expect(contextOf(await runHook(app, 'lib.ts'))).toContain('eslint(no-debugger)')
    })

    // An ignore pattern does not apply to a tracked file; `check-ignore --no-index` would say it does.
    test('still checks a tracked file an ignore pattern matches', async () => {
      const result = await runHook((dir) => {
        app(dir)
        writeFileSync(join(dir, 'scratch', 'kept.ts'), FLAGGED_FILE)
        git(dir, 'add', '-f', 'scratch/kept.ts')
        git(dir, 'commit', '-q', '-m', 'init')
      }, 'scratch/kept.ts')

      expect(contextOf(result)).toContain('After editing scratch/kept.ts:')
    })
  })

  describe('after the agent cd-ed into a subdirectory', () => {
    const app = async (dir: string) => {
      await linkOxlint(dir)
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      mkdirSync(join(dir, 'modules', 'foo'), { recursive: true })
      writeFileSync(join(dir, 'modules', 'foo', 'lib.ts'), FLAGGED_FILE)
    }
    const edit = { tool_input: { file_path: 'lib.ts' } }
    const run = (options: Parameters<typeof runAgentHook>[4]) =>
      runAgentHook(template, '.claude/hooks/check-after-edit.ts', edit, app, { subdir: 'modules/foo', ...options })

    test('judges the edited file from the app root, not the cwd', async () => {
      const context = contextOf(await run({}))

      expect(context).toContain('After editing modules/foo/lib.ts:')
      expect(context).toContain('eslint(no-debugger)')
    })

    test('the shipped settings.json command reaches the hook through CLAUDE_PROJECT_DIR', async () => {
      const command = await shippedHookCommand('targets/claude/settings.json', 'PostToolUse')
      const result = await run({ argv: ['bash', '-c', command], env: (dir) => ({ CLAUDE_PROJECT_DIR: dir }) })

      expect(result.stderr).not.toContain('Module not found')
      expect(contextOf(result)).toContain('eslint(no-debugger)')
    })

    // Claude Code keeps CLAUDE_PROJECT_DIR at the original checkout after it enters a worktree,
    // and the session cwd (here `/`) need not be anywhere near the edited file.
    test("judges a worktree's file from the worktree, running the project's copy", async () => {
      const result = await runAgentHook(template, '.claude/hooks/check-after-edit.ts', { ...edit, cwd: '/' }, async (dir) => {
        const worktree = join(dir, '.claude', 'worktrees', 'x')
        mkdirSync(join(worktree, '.claude', 'hooks'), { recursive: true })
        writeFileSync(join(worktree, '.claude', 'hooks', 'check-after-edit.ts'), readFileSync(template, 'utf8'))
        await app(worktree)
      }, { subdir: '.claude/worktrees/x/modules/foo' })

      expect(contextOf(result)).toContain('After editing modules/foo/lib.ts:')
    })
  })
})

describe('check-after-edit hook: guren check', () => {
  // A routes file the entry does not call yet: the middle of a change that spans two files.
  const UNWIRED_ROUTES = {
    'routes/web.ts': `console.log('routes loaded')
process.stdout.write('routes written\\n')
import { Router } from '@guren/core'

export function registerWebRoutes(baseRouter: Router): void {
  baseRouter.get('/', [HomeController, 'index'])
}
`,
    'routes/admin.ts': `import { Router } from '@guren/core'

export function registerAdminRoutes(router: Router): void {
  router.get('/admin', [AdminController, 'index'])
}
`,
  }

  // The checks import the routes file in this process, so what it prints must not reach
  // stdout. NODE_ENV=test (the runner's) would also hide consola's info lines.
  test('hands a half-done change to the agent as context, with the app output kept off stdout', async () => {
    const result = await runAgentHook(
      template,
      '.claude/hooks/check-after-edit.ts',
      { tool_input: { file_path: 'routes/admin.ts' } },
      (dir) => writeWorkspaceFiles(dir, UNWIRED_ROUTES),
      { env: () => ({ NODE_ENV: 'development' }) },
    )

    const context = contextOf(result)
    expect(context).toContain('After editing routes/admin.ts:')
    expect(context).toContain('guren check found')
    expect(context).toContain('404')
    expect(result.stderr).toContain('routes loaded')
    expect(result.stderr).toContain('routes written')
  })

  test('an unresolvable @guren/cli is reported as context, not read as clean', async () => {
    const result = await runAgentHook(
      template,
      '.claude/hooks/check-after-edit.ts',
      { tool_input: { file_path: 'routes/admin.ts' } },
      async (dir) => {
        rmSync(join(dir, 'node_modules', '@guren', 'cli'), { recursive: true, force: true })
        await writeWorkspaceFiles(dir, UNWIRED_ROUTES)
      },
    )

    expect(contextOf(result)).toContain('guren check could not run: @guren/cli is not resolvable')
  })
})
