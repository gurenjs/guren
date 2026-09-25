import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { builtinSubCommands } from '../src/commands'
import { PLAN_COMMAND_CLASSES } from '../src/plan/command-allowlist'
import { buildPlanPrompt, PLAN_PROMPT_SCHEMA_DELIMITER } from '../src/plan/prompt'
import { planDraftJsonSchema } from '../src/plan/schema'
import { resolveValue } from '../src/run-cli'
import { CLI_BIN_PATH } from './helpers'

const REQUEST = 'comments on posts, authors can delete their own'

/**
 * Each rule the prompt must carry (RFC 0030 §1, §8 and the Part 3 reshape), by a phrase
 * that states it. Rewording a rule means updating its phrase here; dropping one fails.
 */
const RULES: Array<[string, string]> = [
  ['questions are data', 'goes in `questions` as data'],
  ['a question has options with consequences', 'at least two `options` each with its `consequence`'],
  ['a question names its assumed option', '`assumed` naming the option the plan is written under'],
  ['a question names what it affects', '`affects` listing the ids of the elements that change'],
  ['unasked decisions are assumptions', 'What you decided without being told goes in `assumptions`'],
  ['a one-sentence change needs no plan', 'answer that it needs no plan, with a one-line reason'],
  ['the plan file', 'Write it to `docs/plans/<slug>/plan.json`'],
  ['the schema', 'validate against the JSON Schema (draft-07) given with this prompt'],
  ['baseline is never written', 'Never write `baseline`'],
  ['locale is the request language', "`locale` is the BCP 47 tag of the request's language"],
  ['ids share one namespace', 'Ids share one namespace across the whole plan'],
  ['ids are namespaced by section', '`model.comment`, `column.comment.body`'],
  ['ids are stable', 'Keep ids stable'],
  ['ids avoid Object.prototype', '`Object.prototype` member'],
  ['change kinds', '`change.kind` is `existing`'],
  ['existing code is referenced', 'A model lists only the columns the plan touches or references'],
  ['dataMigration', 'states `dataMigration`'],
  ['alters state readable properties', 'Put the change in the fields that are read'],
  ['plan:approve warns on held alters', '`plan:approve` warns about an `alter` whose readable properties all hold already'],
  ['prose alone verifies nothing', 'An alter described only in prose'],
  ['tasks carry acceptance behaviours', 'its `acceptance` behaviours'],
  ['acceptance ids start with AC-', "Each behaviour's `id` starts with `AC-`"],
  ['the unwanted cases are covered', 'Cover the unwanted cases'],
  ['values are JSON text', 'the value written as JSON text'],
  ['a form post redirects with 303', '`"status": 303`'],
  ['ordering goes in hints', 'ordering advice goes in `hints`'],
  ['commands are generators only', '`commands` holds only the Guren generators'],
  ['commands name no absolute path or ..', 'an absolute path or a `..` segment fails the check'],
  ['make:migration is refused', 'not `make:migration` or `add plugin`'],
  ['plan:render validates', '`bunx guren plan:render docs/plans/<slug>/plan.json --json`'],
  ['a failing check is fixed', 'until no check has `"status": "fail"`'],
  ['approval is left to the person', 'Do not run `plan:approve`'],
]

interface ArgShape {
  type?: string
  alias?: string | string[]
}

async function declaredFlags(command: string): Promise<Set<string>> {
  const def = (builtinSubCommands as Record<string, { args?: unknown }>)[command]
  const args = (await resolveValue(def?.args)) as Record<string, ArgShape> | undefined
  const flags = new Set<string>()
  for (const [name, arg] of Object.entries(args ?? {})) {
    if (arg.type === 'positional') continue
    flags.add(name)
    for (const alias of [arg.alias ?? []].flat()) flags.add(alias)
  }
  return flags
}

// Never imported here: its replacements would outlive this file under `--isolate`.
const DENY_SPAWN = join(import.meta.dir, 'fixtures/deny-spawn-preload.ts')

/** The real binary, with every process spawn turned into exit 97 by the preload. */
async function runPlan(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', '--preload', DENY_SPAWN, CLI_BIN_PATH, 'plan', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, exitCode }
}

describe('buildPlanPrompt', () => {
  test('should hand over the draft schema a plan is parsed with', () => {
    expect(buildPlanPrompt(REQUEST).schema).toEqual(planDraftJsonSchema())
  })

  test.each(RULES)('should state the rule: %s', (_rule, phrase) => {
    expect(buildPlanPrompt(REQUEST).prompt).toContain(phrase)
  })

  test('should quote the request between its markers', () => {
    expect(buildPlanPrompt(`  ${REQUEST}\n`).prompt).toContain(`<<<REQUEST\n${REQUEST}\nREQUEST>>>`)
  })

  test('should tell the agent to ask when no request was given', () => {
    for (const request of [undefined, '', '   ']) {
      const { prompt } = buildPlanPrompt(request)
      expect(prompt).toContain('No request was given. Ask the person what change they want planned')
      expect(prompt).not.toContain('<<<REQUEST')
    }
  })

  test('should allow exactly the generators the command allowlist allows', () => {
    const sentence = /The subcommands allowed: ([^.]+)\./.exec(buildPlanPrompt(REQUEST).prompt)?.[1]
    const listed = [...(sentence ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1])
    const generators = Object.entries(PLAN_COMMAND_CLASSES)
      .filter(([, verdict]) => verdict === 'generator')
      .map(([name]) => name)
    expect(listed).toEqual(generators)
    expect(listed).not.toContain('make:migration')
    expect(listed).not.toContain('add plugin')
  })

  test('should name only registered commands and the flags they declare', async () => {
    const invocations = [...buildPlanPrompt(REQUEST).prompt.matchAll(/`bunx guren ([a-z][a-z0-9:-]*)([^`]*)`/g)]
    expect(invocations.map((match) => match[1])).toEqual(['context', 'context', 'model:list', 'guidelines', 'plan:render'])
    for (const [, command, rest] of invocations) {
      expect(Object.keys(builtinSubCommands), command).toContain(command!)
      const declared = await declaredFlags(command!)
      for (const [, flag] of rest!.matchAll(/--([a-z][a-z-]*)/g)) expect(declared, `${command} --${flag}`).toContain(flag!)
    }
  })
})

describe('guren plan', () => {
  test('should print the prompt, the delimiter, then the schema as JSON', async () => {
    const { stdout, exitCode } = await runPlan(['comments', 'on', 'posts', '--print-prompt'])
    expect(exitCode).toBe(0)
    const [prompt, schema, ...rest] = stdout.split(`\n${PLAN_PROMPT_SCHEMA_DELIMITER}\n`)
    expect(rest).toEqual([])
    expect(prompt).toBe(buildPlanPrompt('comments on posts').prompt)
    expect(prompt).not.toContain(PLAN_PROMPT_SCHEMA_DELIMITER)
    expect(JSON.parse(schema!)).toEqual(planDraftJsonSchema())
  })

  test('should print { prompt, schema } under --json', async () => {
    const { stdout, exitCode } = await runPlan([REQUEST, '--print-prompt', '--json'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual(buildPlanPrompt(REQUEST))
  })

  test('should refuse without --print-prompt, naming it and printing nothing to stdout', async () => {
    for (const args of [[REQUEST], [REQUEST, '--json']]) {
      const { stdout, stderr, exitCode } = await runPlan(args)
      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('guren plan --print-prompt')
    }
  })

  test('should refuse --revise, with or without a slug, naming plan:revise', async () => {
    for (const args of [['--revise'], ['--revise', 'comments', '--print-prompt']]) {
      const { stdout, stderr, exitCode } = await runPlan(args)
      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('guren plan:revise')
    }
  })
})
