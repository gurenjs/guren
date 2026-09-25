/**
 * Preloaded into a CLI child by `tests/plan-prompt.test.ts`: any process spawn ends the child with
 * exit 97. Every `node:child_process` entry point ends in `Bun.spawn`/`Bun.spawnSync`; the loop over
 * the module object is a second net, and cannot reach a named import, which keeps its own binding.
 * It runs in a child because replacing these inside `bun test --isolate` outlived the file and
 * crashed a later file's spawn.
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
