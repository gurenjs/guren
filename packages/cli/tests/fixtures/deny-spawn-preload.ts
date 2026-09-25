/**
 * Preloaded into a CLI child by `tests/plan-prompt.test.ts`: any process spawn ends the child with
 * exit 97. On Bun 1.3.11 and 1.3.14 every `node:child_process` entry point, named imports included,
 * ends in `Bun.spawn`/`Bun.spawnSync`; the module-object loop covers a runtime where one does not
 * (1.4.x unprobed), and reaches calls through the module object only. It runs in a child because
 * replacing these inside `bun test --isolate` outlived the file and crashed a later file's spawn.
 */
import * as childProcess from 'node:child_process'

function deny(name: string): () => never {
  return () => {
    process.stderr.write(`spawned through ${name}\n`)
    process.exit(97)
  }
}

const nodeModule = (childProcess as unknown as { default: Record<string, unknown> }).default
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  nodeModule[name] = deny(`node:child_process ${name}`)
}
const bun = Bun as unknown as Record<string, unknown>
for (const name of ['spawn', 'spawnSync']) bun[name] = deny(`Bun.${name}`)
