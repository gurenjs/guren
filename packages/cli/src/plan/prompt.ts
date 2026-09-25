/**
 * The prompt and schema a producer writes a plan from (RFC 0030 §8). `guren plan --print-prompt`
 * prints them for an agent already in a session; the deferred headless producer is to call the
 * same builder. Pure: the application's context is not embedded, the prompt names the read-only
 * commands that print it, so nothing here imports app code or needs a size bound.
 */

import { PLAN_COMMAND_CLASSES, PLAN_COMMAND_FORM } from './command-allowlist'
import { planDraftJsonSchema } from './schema'

export interface PlanPrompt {
  prompt: string
  schema: Record<string, unknown>
}

/** Every generator a plan's `commands` may name, in the table's order. */
function allowedGenerators(): string[] {
  return Object.entries(PLAN_COMMAND_CLASSES)
    .filter(([, verdict]) => verdict === 'generator')
    .map(([name]) => `\`${name}\``)
}

function requestSection(request: string | undefined): string {
  const text = request?.trim()
  if (!text) {
    return [
      '## The request',
      '',
      'No request was given. Ask the person what change they want planned, and what it must and must not do, before you read the code or write anything.',
    ].join('\n')
  }
  return [
    '## The request',
    '',
    'The person asked for this change, quoted between the markers:',
    '',
    '<<<REQUEST',
    text,
    'REQUEST>>>',
  ].join('\n')
}

const INTRO = `You are writing an implementation plan for a change to a Guren application (RFC 0030). A plan is a design document, written as JSON before any code exists. Guren checks it against the application and renders it as a page a person reviews. Once that person approves it, Guren derives the implementation steps from it and reads the progress from the code. Write the plan; do not implement it.`

const CONTEXT = `## Read the application first

Plan against what exists. These commands only read:

- \`bunx guren context --json\`: the models, routes, controllers and pages of the whole application
- \`bunx guren context <Entity>\`: one model with its routes, pages, resource, policy and linked docs (\`--module <name>\` when two modules declare it)
- \`bunx guren model:list --format json\`: the models with their tables and relationships
- \`bunx guren guidelines\`: the conventions this application follows

Read the source files where these leave a question open.`

const QUESTIONS = `## Ask, then record what stays open

If you can ask the person, ask the questions that change the design (a structural choice, who may do what, what happens to existing rows) before you write the JSON. Whatever is still undecided when you write goes in \`questions\` as data: the \`question\`, at least two \`options\` each with its \`consequence\`, \`assumed\` naming the option the plan is written under, and \`affects\` listing the ids of the elements that change if the answer differs. Write the rest of the plan under the assumed option. What you decided without being told goes in \`assumptions\`. A plan with an open question cannot be approved.

If the change can be described in one sentence (one column, one form field), answer that it needs no plan, with a one-line reason, and write no document.`

const DOCUMENT = `## The document

- Write it to \`docs/plans/<slug>/plan.json\`, where \`<slug>\` is a short kebab-case name for the change (\`comments\`).
- It must validate against the JSON Schema (draft-07) given with this prompt. \`planVersion\` is \`1\`.
- Never write \`baseline\`. \`plan:approve\` stamps it when the person approves the plan, and the draft schema has no such field.
- \`locale\` is the BCP 47 tag of the request's language (\`en\`, \`ja\`). Write every piece of prose in that language: the summary, descriptions, rules, questions and acceptance descriptions.
- Every section is optional. Leave out the ones the change does not touch.`

const IDS = `## Ids and changes

- Every element has an \`id\` and a \`change\`. Ids share one namespace across the whole plan, start with a letter, and hold letters, digits, \`_\`, \`.\`, \`:\` and \`-\`. Name them by section and name: \`model.comment\`, \`column.comment.body\`, \`validator.comment\`, \`controller.comments\`, \`action.comments.store\`, \`route.comments.store\`, \`view.posts.show\`, \`policy.comment\`. An id may not be \`constructor\`, \`toString\` or any other \`Object.prototype\` member.
- Keep ids stable: other elements, questions and later revisions address an element by its id alone.
- \`change.kind\` is \`existing\` (referenced, not touched), \`add\`, \`alter\` (changed in place), \`rename\` (\`from\` is the old name: a model's class, a column's property, a route's name) or \`drop\` (\`reason\` says why).
- Reference existing code as \`existing\` elements rather than restating it. A model lists only the columns the plan touches or references.
- An \`alter\`, \`rename\` or \`drop\` of an existing model or column states \`dataMigration\`: \`none\` with a \`reason\`, or \`backfill\` or \`manual\` with a \`description\`.
- A form field names a validator field rather than restating its rules. Elements in an application module carry \`module\`.`

const ALTERS = `## State every alter in properties Guren reads

Guren verifies an \`alter\` by reading its planned properties back from the code, and \`plan:approve\` warns about an \`alter\` whose readable properties all hold already. An alter described only in prose (an action's \`rules\`, a policy ability's \`rule\`, a description) leaves nothing to verify. Put the change in the fields that are read:

- a column: \`type\`, \`nullable\`, \`unique\`, \`index\`, \`default\`, \`references\`, \`columnName\`, \`withTimezone\`, \`primaryKey\`
- a model: the \`relationships\` it declares, the names it adds to \`fillable\`, its \`indexes\`, and a renamed table as \`tableRenamedFrom\` beside the new \`table\`
- a validator: each field's \`type\` and \`required\`, and the \`rules\` Guren compares (\`min <n>\`, \`max <n>\`, \`email\`, \`url\`, \`uuid\`)
- an action: its \`body\`, \`params\` or \`query\` validator, its policy \`ability\`, and a \`response\` of kind \`inertia\`, \`resource\` or \`redirect\`
- a route: \`method\`, \`path\`, \`action\`, \`middleware\`, \`bind\`, \`agent\`
- a resource: \`fields\`

A change that no property can carry, such as a business rule or a removal, is proven by an acceptance behaviour that tests it. An altered action needs a behaviour naming one of its routes.`

const TASKS = `## Tasks and acceptance behaviours

- A task names an \`entity\`, a \`summary\`, the element ids it \`covers\`, and its \`acceptance\` behaviours. A task says what a slice must achieve, never when: ordering advice goes in \`hints\`.
- Each behaviour's \`id\` starts with \`AC-\` and names the task (\`AC-comments-1\`). The implementation's tests carry it in brackets in their titles.
- \`kind\` is \`success\`, \`validation\`, \`unauthenticated\`, \`forbidden\`, \`not-found\` or \`state\`. Cover the unwanted cases: a route whose action names a validator needs a \`validation\` behaviour, a route behind authentication an \`unauthenticated\` one, and an action that enforces a policy a \`forbidden\` one.
- \`route\` is a route id. \`input\`, and the \`has\` and \`missing\` of \`expect.database\`, are lists of \`{ "name": "body", "json": "\\"Nice post\\"" }\`, the value written as JSON text.
- Guren redirects a non-GET request with 303, so a behaviour that expects the redirect after a form post says \`"status": 303\`.`

function commandsSection(): string {
  return `## Commands

\`commands\` holds only the Guren generators the change needs before it is implemented, each written as ${PLAN_COMMAND_FORM}. The subcommands allowed: ${allowedGenerators().join(', ')}. Nothing else passes: not \`make:migration\` or \`add plugin\`, not \`bun run db:migrate\` (the data step runs migrations), not \`codegen\`. Arguments hold letters, digits and \`_-.,:/=@+%\`, with single or double quotes around a value that has spaces. A shell operator, \`$\`, a backslash, an absolute path or a \`..\` segment fails the check.`
}

const CHECK = `## Check the plan

Run \`bunx guren plan:render docs/plans/<slug>/plan.json --json\` once the file is written. A schema error names the field at fault. Otherwise it prints \`{ path, checks }\` as JSON: fix the plan and run it again until no check has \`"status": "fail"\`. Fix the warnings that are mistakes, and tell the person about the ones you leave. The page at \`path\` is what the person reviews.

Do not run \`plan:approve\`. Approval is the person's decision, made after reading the page.`

/** `request` is the person's words, or absent when the agent is to ask for them first. */
export function buildPlanPrompt(request?: string): PlanPrompt {
  const prompt = [INTRO, requestSection(request), CONTEXT, QUESTIONS, DOCUMENT, IDS, ALTERS, TASKS, commandsSection(), CHECK].join('\n\n')
  return { prompt: `${prompt}\n`, schema: planDraftJsonSchema() }
}

/** Where the printed prompt ends and the schema begins in `guren plan --print-prompt`'s text output. */
export const PLAN_PROMPT_SCHEMA_DELIMITER = '===== plan draft JSON Schema (draft-07) ====='

export function formatPlanPrompt({ prompt, schema }: PlanPrompt): string {
  return `${prompt}\n${PLAN_PROMPT_SCHEMA_DELIMITER}\n${JSON.stringify(schema, null, 2)}`
}
