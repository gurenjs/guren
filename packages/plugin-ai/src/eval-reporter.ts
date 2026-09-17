/**
 * The default reporter (RFC 0029 §10): `.claude/hillclimb/<flow>/<variant>/`. Guren emits
 * this layout because it is the one the claude-api harness's report builders and
 * `hillclimb` already read; it ships no viewer of its own, and `defineEval({ reporter })`
 * swaps the layout for another.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  EvalFailure,
  EvalReporter,
  EvalReporterHandle,
  EvalRow,
  EvalRunContext,
  EvalSummary,
  EvalTraceTurn,
} from './eval-types'

export const HILLCLIMB_ROOT = '.claude/hillclimb'

export interface HillclimbReporterOptions {
  /** Defaults to `.claude/hillclimb`, resolved against `cwd`. */
  root?: string
  cwd?: string
  onWarning?: (message: string) => void
}

export function hillclimbReporter(options: HillclimbReporterOptions = {}): EvalReporter {
  const cwd = options.cwd ?? process.cwd()
  const root = resolve(cwd, options.root ?? HILLCLIMB_ROOT)

  return {
    begin(context: EvalRunContext): EvalReporterHandle {
      const directory = resolve(root, context.flow, context.variant)
      if (context.dryRun) {
        return { completed: [], location: directory, row: () => {}, failure: () => {}, end: () => {} }
      }

      mkdirSync(resolve(directory, 'traces'), { recursive: true })
      const results = resolve(directory, 'results.jsonl')
      const errors = resolve(directory, 'errors.jsonl')
      const completed = readRows(results, options.onWarning)
      writeStateOnce(resolve(directory, '_state.json'), context)

      return {
        completed,
        location: directory,
        row(row: EvalRow, trace: EvalTraceTurn[]): void {
          writeFileSync(resolve(directory, 'traces', `${safeName(row.caseId)}_rep${row.rep}.json`), `${JSON.stringify(trace, null, 2)}\n`)
          // Appended as each row settles, so a run killed halfway leaves every row it paid for.
          appendFileSync(results, `${JSON.stringify(row)}\n`)
        },
        failure(failure: EvalFailure): void {
          appendFileSync(errors, `${JSON.stringify(failure)}\n`)
        },
        end(summary: EvalSummary): void {
          writeFileSync(resolve(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
        },
      }
    },
  }
}

function readRows(path: string, onWarning?: (message: string) => void): EvalRow[] {
  if (!existsSync(path)) return []
  const rows: EvalRow[] = []
  let skipped = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as EvalRow
      if (typeof row.caseId === 'string' && typeof row.rep === 'number') rows.push(row)
      else skipped += 1
    } catch {
      // A run killed mid-append leaves a partial last line; it costs one re-run, not the file.
      skipped += 1
    }
  }
  if (skipped > 0) onWarning?.(`${path} has ${skipped} unreadable row(s); those (case, rep) pairs will run again.`)
  return rows
}

/**
 * The split is written once and never edited afterwards: a run that reshuffled it would
 * move cases between dev and test between rounds, which is the one thing a hill-climbing
 * loop cannot tolerate.
 */
function writeStateOnce(path: string, context: EvalRunContext): void {
  if (existsSync(path)) return
  const seed = Math.floor(Math.random() * 0xffffffff)
  const random = mulberry32(seed)
  const strata = new Map<string, string[]>()
  for (const kase of context.cases) {
    const stratum = kase.tags?.[0] ?? ''
    const bucket = strata.get(stratum)
    if (bucket) bucket.push(kase.id)
    else strata.set(stratum, [kase.id])
  }

  const dev: string[] = []
  const test: string[] = []
  // Assigned alternately across the concatenated strata rather than within each one:
  // a stratum of a single case would otherwise land wholly on one side, and a set of
  // small strata can put every case there.
  const ordered = [...strata.values()].flatMap((ids) => shuffle(ids, random))
  for (const [index, id] of ordered.entries()) {
    (index % 2 === 0 ? dev : test).push(id)
  }

  writeFileSync(path, `${JSON.stringify({ version: 1, flow: context.flow, createdAt: context.startedAt, seed, split: { dev, test } }, null, 2)}\n`)
}

function shuffle(ids: readonly string[], random: () => number): string[] {
  const shuffled = [...ids]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!]
  }
  return shuffled
}

/** mulberry32: a seeded PRNG, so `_state.json` records the seed that produced its split. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A case id is free text; a trace file name is not. The row keeps the true id. */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}
