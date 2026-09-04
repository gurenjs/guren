import { describe, expect, it } from 'bun:test'
import { runCommand } from 'citty'
import { stripAnsi } from 'consola/utils'
import { CLI_BIN_PATH, SERVER_DIST_ENTRY, assertWorkspaceBuilt } from './helpers'
import { createNewCommand } from '../src/new-command'

/**
 * Driven through citty rather than a pure argv builder: the bug this covers
 * lived in citty's *parsing*, so a test that skips the parse cannot see it.
 */
async function forwardedArgs(rawArgs: string[]): Promise<string[]> {
  const calls: string[][] = []
  const command = createNewCommand(async (args) => {
    calls.push(args)
  })

  await runCommand(command, { rawArgs })

  expect(calls).toHaveLength(1)
  return calls[0]!
}

describe('guren new', () => {
  it('forwards a string flag with its value instead of parsing it as a boolean', async () => {
    // Regression: `--db` was undeclared, so citty produced `db: true` and leaked
    // "postgres" into `args._`; rebuilt argv dropped it and users got SQLite.
    expect(await forwardedArgs(['my-app', '--db', 'postgres'])).toEqual([
      'x',
      'create-guren-app',
      'my-app',
      '--db',
      'postgres',
    ])
  })

  it('forwards --no-install, the only way to skip the child default of true', async () => {
    expect(await forwardedArgs(['my-app', '--no-install'])).toEqual([
      'x',
      'create-guren-app',
      'my-app',
      '--no-install',
    ])
  })

  it('forwards flags it declares only for --help', async () => {
    expect(await forwardedArgs(['my-app', '--force', '--mode', 'ssr', '--auth', '--blueprint', 'blog'])).toEqual([
      'x',
      'create-guren-app',
      'my-app',
      '--force',
      '--mode',
      'ssr',
      '--auth',
      '--blueprint',
      'blog',
    ])
  })

  it('forwards flag order and aliases verbatim', async () => {
    expect(await forwardedArgs(['-f', 'my-app', '--db', 'mysql'])).toEqual([
      'x',
      'create-guren-app',
      '-f',
      'my-app',
      '--db',
      'mysql',
    ])
  })

  it('passes no positional through when none was given, leaving the child default to apply', async () => {
    expect(await forwardedArgs([])).toEqual(['x', 'create-guren-app'])
  })

  it('forwards a flag this command does not declare at all', async () => {
    // The contract is "forward everything", not "forward what we mirror": a
    // translation table covering only today's declarations would satisfy every
    // other case here while dropping the next flag `create-guren-app` grows.
    expect(await forwardedArgs(['my-app', '--not-a-declared-flag', 'value'])).toEqual([
      'x',
      'create-guren-app',
      'my-app',
      '--not-a-declared-flag',
      'value',
    ])
  })

  it('forwards the --flag=value form, which the old translation table also dropped', async () => {
    expect(await forwardedArgs(['my-app', '--db=postgres'])).toEqual([
      'x',
      'create-guren-app',
      'my-app',
      '--db=postgres',
    ])
  })

  it('forwards a -- separator and everything after it', async () => {
    expect(await forwardedArgs(['my-app', '--', '--db', 'postgres'])).toEqual([
      'x',
      'create-guren-app',
      'my-app',
      '--',
      '--db',
      'postgres',
    ])
  })

  // The cases above construct the command directly, so none would notice it
  // being unregistered in `bin.ts`. `--help` exercises the real wiring without
  // spawning `create-guren-app`: usage renders and returns before `run()`.
  it('is registered in the CLI, and its help lists the flags it forwards', async () => {
    assertWorkspaceBuilt([SERVER_DIST_ENTRY])

    const { NODE_ENV: _testEnv, ...env } = process.env
    const proc = Bun.spawn(['bun', CLI_BIN_PATH, 'new', '--help'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    const usage = stripAnsi(stdout).replace(/`/g, '')

    expect(exitCode).toBe(0)
    expect(usage).toContain('USAGE guren new')
    expect(usage).toContain('--db')
    expect(usage).toContain('--install')
    expect(usage).toContain('--git')
  })
})
