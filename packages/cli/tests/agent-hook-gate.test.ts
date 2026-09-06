import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The shipped Stop hook, run the way Claude Code runs it: `bun <hook>` with the
// hook input on stdin, from the app root. Bun resolves the hook's `@guren/cli`
// import from the hook file's own location (this checkout), so the real gate runs
// against the temp app; its stage rules are covered by gate.test.ts.

const repoRoot = resolve(import.meta.dir, '../../..')
const hook = join(repoRoot, 'packages/cli/templates/agent/targets/claude/hooks/gate-on-stop.ts')

/** An app the real gate passes: `true` stands in for the subprocess stages. */
const PASSING_APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'hook-fixture', scripts: { codegen: 'true', typecheck: 'true', test: 'true' } }),
  'routes/web.ts': `class HomeController {
  async index() { return null }
}
export default function registerRoutes(router: any) {
  router.get('/', [HomeController, 'index'])
}
`,
  'app/Http/Controllers/HomeController.ts': `export class HomeController {
  async index() { return this.json({ ok: true }) }
}
`,
  '.guren/routes.gen.ts': 'export {}\n',
  '.guren/data.gen.ts': 'export {}\n',
}

function writeApp(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
}

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

function runHook(app: (dir: string) => void, input: Record<string, unknown> = {}): { exitCode: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'guren-hook-gate-'))
  try {
    // Bun would otherwise auto-install @guren/cli from the registry for the import below.
    writeFileSync(join(dir, 'bunfig.toml'), '[install]\nauto = "disable"\n')
    app(dir)
    const result = Bun.spawnSync([process.execPath, hook], {
      cwd: dir,
      stdin: Buffer.from(JSON.stringify(input)),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { exitCode: result.exitCode, stderr: result.stderr.toString() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('gate-on-stop hook', () => {
  test('lets a stop through once a Stop hook has already blocked it', () => {
    const result = runHook((dir) => writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n'), { stop_hook_active: true })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('does not gate a clean working tree', () => {
    const result = runHook((dir) => {
      git(dir, 'init', '-q')
      writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('blocks a stop with uncommitted changes when a stage fails, naming the stage', () => {
    const result = runHook((dir) => {
      git(dir, 'init', '-q')
      writeApp(dir, { ...PASSING_APP, 'package.json': JSON.stringify({ name: 'hook-fixture', scripts: { codegen: 'true', typecheck: 'false', test: 'true' } }) })
    })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: typecheck failed (`bun run typecheck` exited 1)')
    expect(result.stderr).not.toContain('guren gate: check failed')
    expect(result.stderr).toContain('Run `bunx guren gate`')
  })

  test('lets a stop through when the gate passes on uncommitted changes', () => {
    const result = runHook((dir) => {
      git(dir, 'init', '-q')
      writeApp(dir, PASSING_APP)
    })

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
  })

  test('outside a git repository the gate runs (the tree cannot be judged clean)', () => {
    const result = runHook((dir) => writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n'))

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: check failed')
  })
})
