/**
 * `.guren/plans/<slug>.state.json` (RFC 0030 §6): what `plan:verify` records and a fresh
 * clone lacks, one result per step at the fingerprint it ran at. It is git-ignored through
 * a `.gitignore` written beside it, since a committed "verified" is a claim nobody on the
 * new machine has checked. A record names the digest of the plan it ran against, which is
 * how a result from another revision is told apart from a stale one.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { z } from 'zod'

import { formatSchemaIssues } from '../cli-error'
import { canonicalJson } from './identity'
import type { Plan, PlanDraft } from './schema'
import { PLAN_VERIFY_COMMANDS } from './tasks'

export const PLAN_STATE_VERSION = 1

/** Where state lives under the application root. `plan:verify` writes the `.gitignore` there. */
export const PLAN_STATE_DIR = '.guren/plans'

const PlanCommandRecordSchema = z.object({
  command: z.enum(PLAN_VERIFY_COMMANDS),
  /** What ran, e.g. `bun run typecheck`, `bun test tests/a.test.ts`. */
  label: z.string(),
  status: z.enum(['pass', 'fail', 'blocked']),
  durationMs: z.number().int().nonnegative(),
  reason: z.string().optional(),
  findings: z.array(z.string()),
})

const PlanFingerprintSchema = z.object({
  /** App-relative path → SHA-256 of the file's bytes. */
  files: z.record(z.string(), z.string()),
  environment: z.object({
    runtime: z.string(),
    platform: z.string(),
    arch: z.string(),
    hostname: z.string(),
  }),
})

export const PlanStepRecordSchema = z.object({
  outcome: z.enum(['verified', 'failed', 'blocked', 'incomplete']),
  /** {@link planDigest} of the plan the step was verified against. */
  planDigest: z.string(),
  ranAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  commands: z.array(PlanCommandRecordSchema),
  acceptance: z.array(z.object({ id: z.string(), status: z.enum(['pending', 'failing', 'passing']) })),
  /** Elements the step owns that were not at their completion state, `id: state`. */
  incomplete: z.array(z.string()),
  fingerprint: PlanFingerprintSchema,
})

export const PlanStateSchema = z.object({
  stateVersion: z.literal(PLAN_STATE_VERSION),
  steps: z.record(z.string(), PlanStepRecordSchema),
})

export type PlanCommandRecord = z.infer<typeof PlanCommandRecordSchema>
export type PlanFingerprint = z.infer<typeof PlanFingerprintSchema>
export type PlanStepRecord = z.infer<typeof PlanStepRecordSchema>
export type PlanState = z.infer<typeof PlanStateSchema>

export interface PlanStateRead {
  state: PlanState | undefined
  /** Set when a file exists and would not read; `state` is then `undefined`. */
  unreadable?: string
}

/**
 * The plan file's slug: `comments.plan.json` and `comments.json` are both `comments`.
 * A handle, never an identity: two plans of one slug share a state file, and their
 * records are told apart by digest.
 */
export function planSlug(planPath: string): string {
  return basename(planPath).replace(/(\.plan)?\.json$/u, '')
}

/**
 * The SHA-256 of the parsed plan's canonical bytes. For a plan with a baseline this is
 * its hash (RFC 0030 §4); a draft has no identity, and this is only what keys its records.
 */
export function planDigest(plan: PlanDraft | Plan): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')
}

export function planStatePath(appRoot: string, slug: string): string {
  return join(appRoot, PLAN_STATE_DIR, `${slug}.state.json`)
}

/** Absent is `state: undefined` with no reason; a file that exists and does not parse says why. */
export async function readPlanState(appRoot: string, slug: string): Promise<PlanStateRead> {
  const path = planStatePath(appRoot, slug)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: undefined }
    return { state: undefined, unreadable: `${path} could not be read: ${(error as Error).message}` }
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    return { state: undefined, unreadable: `${path} is not valid JSON: ${(error as Error).message}` }
  }
  const parsed = PlanStateSchema.safeParse(document)
  if (!parsed.success) return { state: undefined, unreadable: `${path} does not match the state schema:\n${formatSchemaIssues(parsed.error)}` }
  return { state: parsed.data }
}

/**
 * Replaces one step's record, keeping the others. A state file that would not read is
 * replaced whole: its records were written against other code, and keeping them beside
 * a fresh one would let the unreadable half pass for verified on a later read.
 */
export async function writePlanStepRecord(appRoot: string, slug: string, stepId: string, record: PlanStepRecord): Promise<string> {
  const read = await readPlanState(appRoot, slug)
  const state: PlanState = read.state ?? { stateVersion: PLAN_STATE_VERSION, steps: {} }
  state.steps[stepId] = record

  const dir = join(appRoot, PLAN_STATE_DIR)
  await mkdir(dir, { recursive: true })
  const ignore = join(dir, '.gitignore')
  try {
    await readFile(ignore, 'utf8')
  } catch {
    await writeFile(ignore, '*.state.json\n', 'utf8')
  }
  const path = planStatePath(appRoot, slug)
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return path
}
