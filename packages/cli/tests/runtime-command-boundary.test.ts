import { describe, expect, test } from 'bun:test'
import { CLI_BIN_PATH, createTempRoot, writeWorkspaceFiles } from './helpers'

const commandsUrl = new URL('../src/commands.ts', import.meta.url).href
const runnerUrl = new URL('../src/run-cli.ts', import.meta.url).href

const cases = [
  { name: 'dev missing entry', args: ['dev'], source: undefined, message: 'Could not locate an application entry point' },
  { name: 'console missing entry', args: ['console'], source: undefined, message: 'Could not locate an application entry point' },
  { name: 'dev import failure', args: ['dev'], source: "throw new Error('entry failed')", message: 'Failed to import application entry' },
  { name: 'console ready failure', args: ['console'], source: "export const ready = Promise.reject(new Error('ready failed'))", message: 'Application ready() promise rejected' },
  { name: 'dev bootstrap failure', args: ['dev'], source: "export function bootstrap() { throw new Error('bootstrap failed') }", message: 'bootstrap failed' },
  { name: 'dev listen failure', args: ['dev'], source: "export default { listen() { throw new Error('listen failed') } }", message: 'Failed to start application listener' },
  {
    name: 'queue retry failure', args: ['queue:retry', 'job-1'], message: 'Failed to retry job: retry failed',
    source: `
      const driver = { retryFailedJob() { throw new Error('retry failed') } }
      const manager = { driver: () => driver, hasDriver: () => true, getDefaultDriverName: () => 'memory' }
      export default { listen() {}, container: { has: () => true, make: () => manager } }
    `,
  },
]

describe('runtime command error boundary', () => {
  for (const scenario of cases) {
    test(`${scenario.name} returns failure to the caller without exiting`, async () => {
      const root = await createTempRoot('guren-runtime-command-')
      if (scenario.source) await writeWorkspaceFiles(root, { 'src/main.ts': scenario.source })
      const script = `
        import { builtinSubCommands } from ${JSON.stringify(commandsUrl)}
        import { runCli } from ${JSON.stringify(runnerUrl)}
        try {
          const code = await runCli({ subCommands: builtinSubCommands }, ${JSON.stringify(scenario.args)})
          console.log('RETURNED:' + code)
        } finally { console.log('CALLER_CLEANUP') }
      `
      const proc = Bun.spawn(['bun', '--eval', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ])
      expect(code).toBe(0)
      expect(stdout).toContain('RETURNED:1')
      expect(stdout).toContain('CALLER_CLEANUP')
      expect(stderr).toContain(scenario.message)
      expect(stderr.match(/\[error\]/g)?.length).toBe(1)
    })
  }

  test('console still opens after a boot failure and closes on EOF', async () => {
    const root = await createTempRoot('guren-console-boot-warning-')
    await writeWorkspaceFiles(root, { 'src/main.ts': "export default { listen() {}, boot() { throw new Error('provider failed') } }" })
    const { NODE_ENV: _testEnv, ...env } = process.env
    const proc = Bun.spawn(['bun', CLI_BIN_PATH, 'console'], { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), 4000)
    try {
      const stdout = (async () => {
        let output = ''
        let closed = false
        for await (const chunk of proc.stdout) {
          output += new TextDecoder().decode(chunk)
          if (!closed && output.includes('guren>')) {
            closed = true
            await proc.stdin.end()
          }
        }
        return output
      })()
      const [output, stderr, code] = await Promise.all([stdout, new Response(proc.stderr).text(), proc.exited])
      expect(code).toBe(0)
      expect(output).toContain('Console ready.')
      expect(stderr).toContain('Application boot() rejected:')
      expect(stderr).toContain('provider failed')
    } finally {
      clearTimeout(timer)
      proc.kill()
    }
  })
})
