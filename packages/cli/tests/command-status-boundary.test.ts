import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { CLI_BIN_PATH, createTempRoot, writeWorkspaceFiles } from './helpers'

const commandsUrl = new URL('../src/commands.ts', import.meta.url).href
const runnerUrl = new URL('../src/run-cli.ts', import.meta.url).href
const HARD_TIMEOUT_MS = 20_000

interface Scenario {
  name: string
  args: string[]
  files?: Record<string, string>
  code: number
  json?: Record<string, unknown> | unknown[]
  diagnostic?: string
}

const scenarios: Scenario[] = [
  { name: 'unsupported rollback', args: ['db:rollback', '--json'], code: 1, json: { status: 'unsupported' } },
  { name: 'storage creation failure', args: ['storage:link'], code: 1, diagnostic: 'Storage directory not found:' },
  {
    name: 'storage removal failure', args: ['storage:link', '--remove'], code: 1,
    files: { 'public/storage': 'not a symbolic link' }, diagnostic: 'is not a symbolic link',
  },
  { name: 'strict doctor', args: ['doctor', '--strict', '--json', '--no-introspect'], code: 1, json: { version: 1 } },
  { name: 'advisory doctor', args: ['doctor', '--json', '--no-introspect'], code: 0, json: { version: 1 } },
  {
    name: 'unhealthy report', args: ['health:check', '--json'], code: 1, json: { status: 'unhealthy' },
    files: { 'app/health.ts': `export const health = {
      check() { return { status: 'unhealthy', timestamp: new Date(), checks: [] } },
      checkOnly() {}, getCheckNames() { return [] },
    }` },
  },
  {
    name: 'healthy report', args: ['health:check', '--json'], code: 0, json: { status: 'healthy' },
    files: { 'app/health.ts': `export const health = {
      check() { return { status: 'healthy', timestamp: new Date(), checks: [] } },
      checkOnly() {}, getCheckNames() { return [] },
    }` },
  },
  { name: 'conflicting check flags', args: ['check', '--ci', '--fix'], code: 1, diagnostic: '--fix regenerates the files' },
  {
    name: 'failed schedule kernel', args: ['schedule:list', '--json'], code: 1, json: [],
    files: { 'app/Console/Kernel.ts': "throw new Error('kernel failed')" }, diagnostic: 'Failed to load the schedule kernel',
  },
  { name: 'failed introspection', args: ['introspect', '--json'], code: 1, json: { status: 'failed' } },
]

describe('diagnostic command result boundary', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name} preserves output and returns control to the caller`, async () => {
      const root = await createTempRoot('guren-command-status-boundary-')
      try {
        await writeWorkspaceFiles(root, scenario.files ?? {})
        const script = `
          import { builtinSubCommands } from ${JSON.stringify(commandsUrl)}
          import { runCli } from ${JSON.stringify(runnerUrl)}
          process.exitCode = 7
          try {
            const code = await runCli({ subCommands: builtinSubCommands }, ${JSON.stringify(scenario.args)})
            const next = await runCli({ run() {} }, [])
            console.log('\\nRESULT:' + JSON.stringify({ code, next, global: process.exitCode }))
          } finally {
            console.log('CALLER_CLEANUP')
            process.exitCode = 0
          }
        `
        for (const bin of [false, true]) {
          const proc = Bun.spawn(bin ? ['bun', CLI_BIN_PATH, ...scenario.args] : ['bun', '--eval', script], {
            cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: HARD_TIMEOUT_MS, killSignal: 'SIGKILL',
          })
          const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
          ])
          expect(proc.signalCode).toBeNull()
          expect(code).toBe(bin ? scenario.code : 0)
          const output = bin ? stdout : stdout.split('\nRESULT:')[0]
          if (!bin) {
            const result = stdout.split('\nRESULT:')[1]?.split('\n')[0]
            expect(JSON.parse(result ?? '{}')).toEqual({ code: scenario.code, next: 0, global: 7 })
            expect(stdout).toContain('CALLER_CLEANUP')
          }
          if (scenario.json) expect(JSON.parse(output)).toMatchObject(scenario.json)
          if (scenario.diagnostic) expect(stderr.split(scenario.diagnostic)).toHaveLength(2)
          else expect(stderr).toBe('')
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, HARD_TIMEOUT_MS * 2 + 5_000)
  }
})
