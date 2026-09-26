import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from './workspace-packages.ts'

/**
 * `bun test --shard=i/n` is green on any subset of its buckets, so a matrix
 * listing 1/4..3/4 never runs a quarter of the files and nothing fails. Each
 * sharded job's list has to be exactly 1/n..n/n.
 */
type Job = { strategy?: { matrix?: { shard?: unknown } } }

const ci = Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}
const sharded = Object.entries(ci.jobs).filter(([, job]) => job.strategy?.matrix?.shard !== undefined)

describe('ci.yml test shards', () => {
  it('finds the sharded jobs', () => {
    expect(sharded.map(([name]) => name).sort()).toEqual(['build-and-test', 'sqlite-smoke'])
  })

  it.each(sharded)('%s lists every bucket of one total', (_name, job) => {
    const shards = job.strategy!.matrix!.shard as string[]
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => `${i + 1}/${shards.length}`))
  })
})
