/**
 * Preloaded into a CLI child by `tests/plan-prompt.test.ts`: any process spawn ends the
 * child with exit 97. Done in a child because replacing `Bun.spawn` or a `node:child_process`
 * export inside `bun test --isolate` outlives the file and crashed a later file's spawn.
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
