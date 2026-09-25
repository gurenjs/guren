import { resolve } from 'node:path'
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
import { formatPlanWaive, planWaiveFile } from '../plan-waive'
import { formatPlanClose, planCloseFile } from '../plan-close'
import { readAppDefaultLocale } from '../app-locale'

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

    console.log(rendered.path)
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
    if (args.ci && report.steps.some((step) => step.record.outcome !== 'verified')) process.exitCode = 1
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
