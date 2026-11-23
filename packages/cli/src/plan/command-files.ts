/**
 * The file each single-file generator a plan's `commands` may run writes, and what it holds (RFC 0040 §3: a
 * file a plan's command writes is declared by that command). The call is read as the §2 check reads it, the
 * path and contents come from the generator's own function, and a flag outside a generator's list declares
 * nothing. Blueprints, `make:auth` and `make:feature` write or patch several files and are not read here.
 */

import { parseFieldsString } from '../fields'
import { channelFile } from '../make-channel'
import { controllerFile } from '../make-controller'
import { eventFile } from '../make-event'
import { factoryFile } from '../make-factory'
import { jobFile } from '../make-job'
import { listenerFile } from '../make-listener'
import { mailFile } from '../make-mail'
import { middlewareFile } from '../make-middleware'
import { modelFile } from '../make-model'
import { notificationFile } from '../make-notification'
import { policyFile } from '../make-policy'
import { providerFile } from '../make-provider'
import { resourceFile } from '../make-resource'
import { routeFile } from '../make-route'
import { validatorFile } from '../make-validator'
import { kebabCase, type ScaffoldFileEntry, type WriterOptions } from '../utils'
import { namedTargets } from './app-targets'
import { judgePlanCommand } from './command-allowlist'
import { PLAN_GENERATOR_TARGETS, readPlanGeneratorCall, type PlanGeneratorCall, type PlanGeneratorTarget } from './command-targets'
import type { PlanController, PlanDraft, PlanPolicy } from './schema'

export interface PlanCommandFileRule {
  /** The flags taking a value, aliases included, as the registry declares them. */
  valueFlags: readonly string[]
  /** The boolean flags it reads, aliases included. */
  booleanFlags: readonly string[]
  /** What the generator writes for the call, one entry per contents it may write there; `undefined` when it writes nothing. */
  files(name: string, flags: CommandFlags, options: WriterOptions): ScaffoldFileEntry[] | undefined
}

interface CommandFlags {
  string(...names: string[]): string | undefined
  on(...names: string[]): boolean
}

const MODULE = ['module', 'M'] as const
const FORCE = ['force', 'f'] as const

const single = (file: (name: string, options: WriterOptions) => ScaffoldFileEntry, valueFlags: readonly string[] = []): PlanCommandFileRule => ({
  valueFlags: [...valueFlags, ...MODULE],
  booleanFlags: FORCE,
  files: (name, _flags, options) => [file(name, options)],
})

/** Every generator whose output is one file a pure function gives; `tests/plan-command-files.test.ts` holds the flags to the registry. */
export const PLAN_COMMAND_FILES: Readonly<Record<string, PlanCommandFileRule>> = Object.assign(Object.create(null), {
  'make:model': single(modelFile),
  'make:job': single(jobFile),
  'make:event': single(eventFile),
  'make:mail': single(mailFile),
  'make:notification': single(notificationFile),
  'make:policy': single(policyFile),
  'make:provider': single(providerFile),
  'make:middleware': single(middlewareFile),
  'make:route': single(routeFile),
  // `makeController()` picks the template by whether the app renders pages, which the plan does not say.
  'make:controller': {
    valueFlags: MODULE,
    booleanFlags: FORCE,
    files: (name, _flags, options) => [controllerFile(name, { ...options, apiOnly: false }), controllerFile(name, { ...options, apiOnly: true })],
  },
  'make:listener': {
    valueFlags: ['event', 'e', ...MODULE],
    booleanFlags: FORCE,
    files: (name, flags, options) => [listenerFile(name, { ...options, event: flags.string('event', 'e') })],
  },
  'make:factory': {
    valueFlags: ['model', 'm', ...MODULE],
    booleanFlags: FORCE,
    files: (name, flags, options) => [factoryFile(name, { ...options, model: flags.string('model', 'm') })],
  },
  'make:resource': {
    valueFlags: ['model', 'm', ...MODULE],
    booleanFlags: FORCE,
    files: (name, flags, options) => [resourceFile(name, { ...options, model: flags.string('model', 'm') })],
  },
  'make:validator': {
    valueFlags: ['fields', 'F', ...MODULE],
    booleanFlags: FORCE,
    files: (name, flags, options) => {
      const fields = flags.string('fields', 'F')
      try {
        // As `make:validator` reads it: an empty `--fields` is no fields, where `parseFieldsString('')` gives the defaults.
        return [validatorFile(name, { ...options, fields: fields ? parseFieldsString(fields) : undefined })]
      } catch {
        return undefined
      }
    },
  },
  'make:channel': {
    valueFlags: ['channel', ...MODULE],
    booleanFlags: ['private', 'p', 'presence', ...FORCE],
    files: (name, flags, options) => [channelFile(name, { ...options, channel: flags.string('channel'), private: flags.on('private', 'p'), presence: flags.on('presence') })],
  },
} satisfies Record<string, PlanCommandFileRule>)

/** How a written file is held: as the generator wrote it, or by the check of the plan element that owns its class. */
export type PlanCommandFileCheck =
  | { kind: 'whole' }
  | { kind: 'exports' }
  | { kind: 'policy'; policy: PlanPolicy }
  | { kind: 'controller'; controller: PlanController }

export interface PlanCommandFile {
  /** The command's id, and the ids of the `add` elements whose class the file declares. */
  commandId: string
  elements: string[]
  path: string
  /** What the generator may write there. */
  contents: string[]
  check: PlanCommandFileCheck
}

/** A flag's long name for each alias the registry gives it: citty keeps whichever spelling comes first, the reader the long one. */
export const PLAN_COMMAND_FLAG_ALIASES: Readonly<Record<string, string>> = { M: 'module', f: 'force', e: 'event', m: 'model', F: 'fields', p: 'private' }

const FLAG_WORD = /^(?:--[a-z][a-z-]*|-[A-Za-z])(?:=(.+))?$/su

/**
 * Whether every word has one shape the registry's parser reads as the reader does: a name; `--flag` or `-f`,
 * with a non-empty `=value` or none; a value flag's value in the next word, which is no flag; a boolean not
 * followed by `true` or `false`, which the parser takes as its value. Anything else (`--`, a cluster, an empty
 * `=`) is refused, and so is a quote, which would reach a generated string literal unescaped.
 */
function readsAsCitty(rule: PlanCommandFileRule, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!
    if (/['"`]/u.test(word)) return false
    if (!word.startsWith('-')) continue
    const shape = FLAG_WORD.exec(word)
    if (!shape) return false
    if (shape[1] !== undefined) continue
    const flag = word.replace(/^--?/u, '')
    const next = args[index + 1]
    if (rule.valueFlags.includes(flag)) {
      if (next === undefined || next.startsWith('-')) return false
      index += 1
    } else if (next !== undefined && /^(?:true|false)$/u.test(next)) {
      return false
    }
  }
  return true
}

/** The flags as the generator's command reads them, or `undefined` when the call sets one the rule does not list. */
function readFlags(rule: PlanCommandFileRule, call: PlanGeneratorCall): CommandFlags | undefined {
  for (const [alias, long] of Object.entries(PLAN_COMMAND_FLAG_ALIASES)) if (call.flags.has(alias) && call.flags.has(long)) return undefined
  for (const [flag, value] of call.flags) {
    if (rule.valueFlags.includes(flag) ? typeof value !== 'string' : !rule.booleanFlags.includes(flag) || (value !== true && value !== 'true')) return undefined
  }
  return {
    string: (...names) => names.map((name) => call.flags.get(name)).find((value): value is string => typeof value === 'string'),
    on: (...names) => names.some((name) => call.flags.has(name)),
  }
}

/**
 * The `add` elements whose class a generator's output declares, by its §2 targets, in the command's module. A
 * policy's provider and a routes file are held whole whatever names them: one runs at boot, the other mounts.
 */
function owningElements(plan: PlanDraft, targets: readonly PlanGeneratorTarget[], module: string | undefined): { ids: string[]; check: PlanCommandFileCheck } {
  const inModule = (element: { module?: string }): boolean => (element.module === undefined ? undefined : kebabCase(element.module)) === module
  const named = namedTargets(plan).filter((target) => target.kind === 'add' && inModule(target))
  const ids = new Set<string>()
  let check: PlanCommandFileCheck = { kind: 'exports' }
  for (const target of targets) {
    if (target.section === 'policyProviders' || target.section === 'routes' || target.section === 'tables') return { ids: [], check: { kind: 'whole' } }
    if (target.section === 'sideEffects') {
      for (const effect of plan.sideEffects) if (effect.change.kind === 'add' && effect.kind === target.kind && target.names.includes(effect.name) && inModule(effect)) ids.add(effect.id)
      continue
    }
    const names = target.section === 'validators' ? target.exports : target.names
    for (const element of named.filter((entry) => entry.section === target.section && names.includes(entry.current))) {
      ids.add(element.id)
      const policy = target.section === 'policies' ? plan.policies.find((entry) => entry.id === element.id) : undefined
      const controller = target.section === 'controllers' ? plan.controllers.find((entry) => entry.id === element.id) : undefined
      if (policy) check = { kind: 'policy', policy }
      if (controller) check = { kind: 'controller', controller }
    }
  }
  return ids.size === 0 ? { ids: [], check: { kind: 'whole' } } : { ids: [...ids], check }
}

/** The file each of the plan's commands writes, in command order; a command that cannot be placed adds nothing. */
export function planCommandFiles(plan: PlanDraft): PlanCommandFile[] {
  return plan.commands.flatMap((command) => {
    const verdict = judgePlanCommand(command.command)
    const rule = verdict.allowed ? PLAN_COMMAND_FILES[verdict.subcommand] : undefined
    if (!verdict.allowed || rule === undefined || !readsAsCitty(rule, verdict.args)) return []
    const call = readPlanGeneratorCall({ valueFlags: rule.valueFlags, positional: true, targets: () => ({ writes: [], imports: [] }) }, verdict.args)
    const flags = call && readFlags(rule, call)
    if (!call?.name || !flags) return []
    const moduleFlag = flags.string(...MODULE)
    const options: WriterOptions = moduleFlag === undefined ? {} : { root: moduleFlag }
    let written: ScaffoldFileEntry[] | undefined
    try {
      written = rule.files(call.name, flags, options)
    } catch {
      // A name or module the generator refuses writes nothing.
      return []
    }
    const [first] = written ?? []
    if (!first || written!.some((entry) => entry.path !== first.path)) return []
    const targetRule = PLAN_GENERATOR_TARGETS[verdict.subcommand]
    const targets = typeof targetRule === 'object' ? targetRule.targets(call).writes : []
    const { ids, check } = owningElements(plan, targets, moduleFlag === undefined ? undefined : kebabCase(moduleFlag))
    return [{ commandId: command.id, elements: ids, path: first.path, contents: written!.map((entry) => entry.contents), check }]
  })
}

/** Generators whose writes cannot coincide with a file the table above gives: docs, tests, pages, catalogs, UI components. */
const WRITES_ELSEWHERE = new Set(['make:adr', 'make:lesson', 'make:test', 'make:lang', 'lang:publish', 'make:view', 'add lint', 'add ui'])

/**
 * Every path a command of the plan may write, read loosely: each word, and each part of a `flag=value`, as a
 * name and as a module root, beside the project root. A refused command or any other generator is `'all'`: a blueprint or a
 * multi-file generator writes more than its §2 targets name (`make:feature --factory`, a blueprint's provider).
 * A second command or plan naming a path here is a claim, whether or not its own call reads.
 */
export function planCommandClaims(plan: PlanDraft): Map<string, Set<string> | 'all'> {
  const claims = new Map<string, Set<string> | 'all'>()
  for (const command of plan.commands) {
    const verdict = judgePlanCommand(command.command)
    if (verdict.allowed && WRITES_ELSEWHERE.has(verdict.subcommand)) continue
    // A command the allowlist refuses (in a plan approved before it) may write anything.
    if (!verdict.allowed) {
      claims.set(command.id, 'all')
      continue
    }
    const tokens = [...new Set(verdict.args.flatMap((word) => word.split('=')).map((part) => part.replace(/^-+/u, '')).filter((part) => part !== ''))]
    const roots = [undefined, ...tokens]
    const rule = PLAN_COMMAND_FILES[verdict.subcommand]
    if (rule) {
      const paths = new Set<string>()
      // After `--` a whole word is the name, dashes and `=` included.
      for (const name of new Set([...tokens, ...verdict.args])) {
        for (const root of roots) {
          try {
            for (const entry of rule.files(name, { string: () => undefined, on: () => false }, root === undefined ? {} : { root }) ?? []) paths.add(entry.path)
          } catch {
            // A name or root the generator refuses writes nothing there.
          }
        }
      }
      claims.set(command.id, paths)
      continue
    }
    claims.set(command.id, 'all')
  }
  return claims
}
