import { resolve } from 'node:path'
import { markCommandFailed } from '../command-status'
import { defineCommand } from '../define-command'
import { CliError } from '../cli-error'
import { renderPlanFile } from '../plan-render'
import { loadPlanAppState } from '../plan/app-state'
import { planChangesExisting } from '../plan/impact'
import { planHasAlter } from '../plan/status'
import { formatPlanApprove, planApproveFile } from '../plan-approve'
import { formatPlanStatus, planStatusFile } from '../plan-status'
import { DEFAULT_VERIFY_TIMEOUT_MS, formatPlanVerify, planVerifyFile } from '../plan-verify'
import { formatPlanNext, planNextFile } from '../plan-next'
import { formatPlanScaffold, formatPlanScaffoldMount, planScaffoldFile, planScaffoldMountFile } from '../plan-scaffold'
import { formatPlanRevise, planReviseFile, withStdinDashes } from '../plan-revise'
import { formatPlanWaive, planWaiveFile } from '../plan-waive'
import { formatPlanClose, planCloseFile } from '../plan-close'
import { readAppDefaultLocale } from '../app-locale'
import { buildPlanPrompt, formatPlanPrompt } from '../plan/prompt'

const planArgs = {
  request: {
    type: 'positional',
    description: 'The change to plan, in your words. Without it, the prompt tells the agent to ask for one.',
    required: false,
    valueHint: '"comments on posts, authors can delete their own"',
  },
  'print-prompt': {
    type: 'boolean',
    description: 'Print the prompt, then the plan JSON Schema (draft-07).',
  },
  json: {
    type: 'boolean',
    description: 'With --print-prompt, print { prompt, schema } as JSON.',
  },
  revise: {
    type: 'string',
    description: 'Not available yet: revising a plan through a model. Edit the plan and run plan:revise.',
    valueHint: 'comments',
  },
} as const

// Dashes and case erased, as citty resolves a spelling to a declared name.
const PLAN_DECLARED_ARGS = new Set(['_', ...Object.keys(planArgs)].map((name) => name.replaceAll('-', '').toLowerCase()))

export const planCommand = defineCommand({
  meta: {
    name: 'plan',
    description:
      'Print the prompt and the JSON Schema an agent writes an implementation plan from (RFC 0030 §8), with --print-prompt. Calls no model and spawns nothing: the agent reading the prompt writes the plan and checks it with plan:render. Asking a model directly is not available yet.',
  },
  args: planArgs,
  async run({ args }) {
    // `revise` is a string flag, so a bare `--revise` arrives as '' and still refuses.
    if (args.revise !== undefined) {
      throw new CliError('guren plan --revise, which asks a model to revise a plan, is not available yet. Edit the plan, then run guren plan:revise.')
    }
    const undeclared = Object.keys(args).filter((name) => !PLAN_DECLARED_ARGS.has(name.replaceAll('-', '').toLowerCase()))
    if (undeclared.length > 0) {
      const flags = undeclared.map((name) => (name.length === 1 ? `-${name}` : `--${name}`)).join(', ')
      throw new CliError(
        `guren plan does not take ${flags}; it takes --print-prompt, --json and --revise. An unquoted request whose words start with - is read as flags too, so quote it: guren plan "<request>" --print-prompt.`,
      )
    }
    if (!args['print-prompt']) {
      throw new CliError(
        'guren plan cannot ask a model for a plan yet (RFC 0030 §8). Run guren plan --print-prompt "<request>" and give its output to the agent in your session, which writes the plan and checks it with guren plan:render.',
      )
    }
    const built = buildPlanPrompt(args._.join(' '))
    console.log(args.json ? JSON.stringify(built, null, 2) : formatPlanPrompt(built))
  },
})

export const planRenderCommand = defineCommand({
  meta: {
    name: 'plan:render',
    description: 'Render an implementation plan as one self-contained interactive HTML file (RFC 0030).',
  },
  args: {
    plan: {
      type: 'positional',
      description: 'Path to the plan JSON file',
      required: true,
      valueHint: 'comments.plan.json',
    },
    output: {
      type: 'string',
      description: 'Where to write the HTML. Defaults to the plan path with a .html extension.',
      alias: 'o',
      valueHint: 'plan.html',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    locale: {
      type: 'string',
      description:
        "The language the page's own labels open in (en or ja); the page can switch between them. Defaults to the plan's locale, then the application's, then en.",
      valueHint: 'ja',
    },
    json: {
      type: 'boolean',
      description: 'Print { path, checks } as JSON: every check the page shows, so an agent can fix the failing ones without opening it.',
      default: false,
    },
  },
  async run({ args }) {
    // The application the plan is checked against, which the plan file need not sit
    // in: a plan is reviewed from wherever it was written. Scanned only once the plan
    // itself has parsed.
    const appRoot = args.app ?? process.cwd()
    const rendered = await renderPlanFile(args.plan, {
      output: args.output,
      // Impact scans the whole application, which only a plan changing something existing needs.
      app: (plan) => loadPlanAppState(appRoot, { impact: planChangesExisting(plan) }),
      locale: args.locale,
      appLocale: () => readAppDefaultLocale(appRoot),
    })

    console.log(args.json ? JSON.stringify(rendered, null, 2) : rendered.path)
  },
})

export const planStatusCommand = defineCommand({
  meta: {
    name: 'plan:status',
    description:
      'Report which elements of an implementation plan exist in the code (RFC 0030), and whether an approval names the plan\'s current hash. Observational: it exits 0 whatever the status, unapproved included, and non-zero only when the plan cannot be read.',
  },
  args: {
    plan: {
      type: 'positional',
      description: 'Path to the plan JSON file',
      required: true,
      valueHint: 'comments.plan.json',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    json: {
      type: 'boolean',
      description: 'Print the report as JSON.',
      default: false,
    },
  },
  async run({ args }) {
    const appRoot = resolve(args.app ?? process.cwd())
    const report = await planStatusFile(args.plan, { app: () => loadPlanAppState(appRoot, { detail: true }), appRoot })
    console.log(args.json ? JSON.stringify(report, null, 2) : formatPlanStatus(report))
  },
})

export const planVerifyCommand = defineCommand({
  meta: {
    name: 'plan:verify',
    description:
      "Run a plan step's verify commands and tests against the application and record the result under .guren/plans/ (RFC 0030). Executes: bun test boots the app and db:migrate opens the database. Refuses, before running anything, a plan with a baseline whose current hash no approval names (run plan:approve). Exits non-zero only when the plan cannot be read or is refused, or with --ci when a step did not verify.",
  },
  args: {
    plan: {
      type: 'positional',
      description: 'Path to the plan JSON file',
      required: true,
      valueHint: 'comments.plan.json',
    },
    step: {
      type: 'string',
      description: 'One derived step id, as plan:next names it or a whole-plan plan:verify reports it. Every step, in task order, when absent.',
      valueHint: 'task/entity/model.comment/http',
    },
    app: {
      type: 'string',
      description: 'Application root directory: where the commands run and the state is written.',
    },
    timeout: {
      type: 'string',
      description: `Seconds each command may take before it is reported as blocked. Default ${DEFAULT_VERIFY_TIMEOUT_MS / 1000}.`,
      valueHint: '600',
    },
    ci: {
      type: 'boolean',
      description: 'Exit 1 when a step this run covered did not verify.',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Print the report as JSON.',
      default: false,
    },
  },
  async run({ args }) {
    const appRoot = resolve(args.app ?? process.cwd())
    const seconds = args.timeout === undefined ? undefined : Number(args.timeout)
    if (seconds !== undefined && !(Number.isFinite(seconds) && seconds > 0)) {
      throw new CliError(`--timeout takes a positive number of seconds, not "${args.timeout}"`)
    }
    const report = await planVerifyFile(args.plan, {
      app: () => loadPlanAppState(appRoot, { detail: true }),
      appRoot,
      step: args.step,
      timeoutMs: seconds === undefined ? undefined : seconds * 1000,
    })
    console.log(args.json ? JSON.stringify(report, null, 2) : formatPlanVerify(report))
    if (args.ci && report.steps.some((step) => step.record.outcome !== 'verified')) markCommandFailed()
  },
})

export const planNextCommand = defineCommand({
  meta: {
    name: 'plan:next',
    description:
      'Print the next step of a plan to implement (RFC 0030 §7) with what it covers: its elements, behaviours and verify commands, never the whole plan. Marks the step under .guren/plans/ so the harness Stop hook verifies it on every stop. Spawns no command; for an approved plan it reads the app (importing the routes file) and skips the steps whose context went stale since approval, naming what changed. Refuses a plan with a baseline whose current hash no approval names (run plan:approve), and a working tree with uncommitted changes unless they are the marked step\'s own.',
  },
  args: {
    plan: {
      type: 'positional',
      description: 'Path to the plan JSON file',
      required: true,
      valueHint: 'comments.plan.json',
    },
    app: {
      type: 'string',
      description: 'Application root directory: where the state is read and the step is marked.',
    },
    json: {
      type: 'boolean',
      description: 'Print the report as JSON.',
      default: false,
    },
  },
  async run({ args }) {
    const appRoot = resolve(args.app ?? process.cwd())
    const report = await planNextFile(args.plan, { appRoot })
    console.log(args.json ? JSON.stringify(report, null, 2) : formatPlanNext(report, args.plan))
  },
})

export const planScaffoldCommand = defineCommand({
  meta: {
    name: 'plan:scaffold',
    description:
      "Write the scaffold step of an approved plan (RFC 0030 §5): each added model's table in db/schema.ts, with every column option and foreign key the plan states, and its model class with the plan's relationships and fillable; the step's validators; each resource and policy of the model, the policy's abilities denying until written, and a provider registering the policy with the gate, added to createApp(); each added controller with exactly the planned actions, which validate and authorize as planned and then answer 501; the routes to them in routes/<collection>.ts, not mounted; the side-effect classes. With --mount, from the http step holding those routes, call that file's registrar first in the entry registrar. Writes no pages or action bodies, and runs no codegen or migration. The step must be the one plan:next marked. Refuses, with nothing written, a draft, another step kind, a module element, an API-only application, a provider it cannot register, any target that already exists, a re-run included, and a mount with nothing to mount or already mounted.",
  },
  args: {
    plan: {
      type: 'positional',
      description: 'Path to the plan JSON file',
      required: true,
      valueHint: 'comments.plan.json',
    },
    step: {
      type: 'string',
      description: 'The scaffold step id, as plan:next names it; with --mount, the http step holding the routes.',
      required: true,
      valueHint: 'task/entity/model.comment/scaffold',
    },
    mount: {
      type: 'boolean',
      description: 'Mount the routes file the scaffold step wrote, from the http step plan:next marked.',
      default: false,
    },
    app: {
      type: 'string',
      description: 'Application root directory: what is read and written, and where the step is marked.',
    },
    json: {
      type: 'boolean',
      description: 'Print the report as JSON.',
      default: false,
    },
  },
  async run({ args }) {
    const appRoot = resolve(args.app ?? process.cwd())
    if (args.mount) {
      const report = await planScaffoldMountFile(args.plan, { appRoot, step: args.step })
      console.log(args.json ? JSON.stringify(report, null, 2) : formatPlanScaffoldMount(report, args.plan))
      return
    }
    const report = await planScaffoldFile(args.plan, { appRoot, step: args.step })
    console.log(args.json ? JSON.stringify(report, null, 2) : formatPlanScaffold(report, args.plan))
  },
})

export const planApproveCommand = defineCommand({
  meta: {
    name: 'plan:approve',
    description:
      "Approve an implementation plan (RFC 0030 §4): stamp a draft's baseline into the plan file once, and record the approval of its hash beside the plan. Refuses while a check fails, a question is open, or the tree is dirty.",
  },
  args: {
    plan: {
      type: 'positional',
      description: 'Path to the plan JSON file',
      required: true,
      valueHint: 'comments.plan.json',
    },
    app: {
      type: 'string',
      description: 'Application root directory: what the plan is checked and stamped against, and where git is asked for HEAD.',
    },
    'allow-unstamped': {
      type: 'boolean',
      description: 'Approve although a section other than validators could not be read, leaving its elements without a context hash.',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Print the report as JSON.',
      default: false,
    },
  },
  async run({ args }) {
    const appRoot = resolve(args.app ?? process.cwd())
    const report = await planApproveFile(args.plan, {
      app: (plan) => loadPlanAppState(appRoot, { detail: planHasAlter(plan) }),
      appRoot,
      allowUnstamped: args['allow-unstamped'],
    })
    console.log(args.json ? JSON.stringify(report, null, 2) : formatPlanApprove(report))
  },
})

export const planWaiveCommand = defineCommand({
  meta: {
    name: 'plan:waive',
    description:
      "Accept elements of an approved plan incomplete, with a reason, in the decision log beside the plan (RFC 0030 §6). The log is committed; a waiver names the plan's hash, so a revision does not inherit it. Loads no application, and runs nothing but `git config` to name who waived. Refuses a draft and a plan whose current hash no approval names; --remove asks neither.",
  },
  args: {
    plan: {
      type: 'positional',
      description: 'Path to the plan JSON file',
      required: true,
      valueHint: 'comments.plan.json',
    },
    elements: {
      type: 'positional',
      description: 'One or more element ids the plan declares (plan:status lists them).',
      required: true,
      valueHint: 'view.comments.index',
    },
    reason: {
      type: 'string',
      description: 'Why the element is accepted incomplete. Required unless --remove is given.',
      valueHint: 'the redesign lands in the next plan',
    },
    remove: {
      type: 'boolean',
      description: 'Delete the waivers of the named elements instead of writing them. Asks nothing of the plan, so a revision can withdraw a waiver of an element it dropped.',
      default: false,
    },
    app: {
      type: 'string',
      description: 'Application root directory: what the reported decision-log path is relative to. The plan is read from its own path either way.',
    },
    json: {
      type: 'boolean',
      description: 'Print the report as JSON.',
      default: false,
    },
  },
  async run({ args }) {
    // citty collects the trailing positionals in `_`, with the first two bound above.
    const ids = [args.elements, ...args._.slice(2)].filter((id) => id.length > 0)
    const report = await planWaiveFile(args.plan, { elementIds: ids, reason: args.reason, remove: args.remove, app: args.app })
    console.log(args.json ? JSON.stringify(report, null, 2) : formatPlanWaive(report))
  },
})

export const planReviseCommand = defineCommand({
  meta: {
    name: 'plan:revise',
    description:
      "Revise an implementation plan without a model (RFC 0030 §4): the plan file as it stands is the parent, and the change comes as ops (--ops) or as an edited copy whose ops are derived (--edited). Records { parent, ops, result } under the plan's revisions directory, then rewrites the plan to the result. With --feedback, an element the feedback approved changes only with a reopens reason, and an answered question must be removed; comments are not turned into ops. Refuses a plan edited in place after approval.",
  },
  args: {
    plan: {
      type: 'positional',
      description: 'Path to the plan JSON file',
      required: true,
      valueHint: 'comments.plan.json',
    },
    ops: {
      type: 'string',
      description: 'A { "ops": [...] } document, each op with its own reason; - reads standard input.',
      valueHint: 'ops.json',
    },
    edited: {
      type: 'string',
      description: 'A copy of the plan with the change made in it, baseline unchanged; its ops are derived. - reads standard input.',
      valueHint: 'comments.edited.json',
    },
    feedback: {
      type: 'string',
      description: "The feedback the plan page exports (feedback.json); - reads standard input. Its approvals lock elements and its answers must be applied.",
      valueHint: 'feedback.json',
    },
    message: {
      type: 'string',
      description: 'With --edited: the reason every derived op records. Required there.',
      valueHint: 'soft-delete comments instead',
    },
    reopens: {
      type: 'string',
      description: 'With --edited: why elements the feedback approved change. Every derived op carries it; it counts only on an approved element.',
    },
    app: {
      type: 'string',
      description: 'Application root directory: what the reported revision path is relative to. The plan is read from its own path either way.',
    },
    json: {
      type: 'boolean',
      description: 'Print the report as JSON.',
      default: false,
    },
  },
  async run({ args, rawArgs }) {
    const documents = withStdinDashes({ ops: args.ops, edited: args.edited, feedback: args.feedback }, rawArgs)
    const report = await planReviseFile(args.plan, {
      ...documents,
      message: args.message,
      reopens: args.reopens,
      app: args.app,
    })
    console.log(args.json ? JSON.stringify(report, null, 2) : formatPlanRevise(report, args.plan))
  },
})

export const planCloseCommand = defineCommand({
  meta: {
    name: 'plan:close',
    description:
      "Close an approved implementation plan whose every element is verified or waived (RFC 0030 §7): write its doc node to docs/plans/<slug>.md and a marker-fenced draft block per section of each touched entity's docs/entities/<Entity>.md, never rewriting text outside the markers. Deletes nothing: the plan, its approvals and its decision log stay committed. Refuses an unapproved plan and names every element still open.",
  },
  args: {
    plan: {
      type: 'positional',
      description: 'Path to the plan JSON file',
      required: true,
      valueHint: 'comments.plan.json',
    },
    app: {
      type: 'string',
      description: 'Application root directory: what the plan is judged against and where the documents are written.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print what would be written, and write nothing.',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Print the report as JSON.',
      default: false,
    },
  },
  async run({ args }) {
    const appRoot = resolve(args.app ?? process.cwd())
    const report = await planCloseFile(args.plan, { app: () => loadPlanAppState(appRoot, { detail: true }), appRoot, dryRun: args['dry-run'] })
    console.log(args.json ? JSON.stringify(report, null, 2) : formatPlanClose(report))
  },
})
