import { consola } from 'consola'
import { defineCommand } from '../define-command'
import { CHECK_SUITES, ciSuiteConflict, runCheck, renderCheckReport } from '../check'
import { gatingResults } from '../check-result'
import { recheckInChild, runCheckFixes, settleFixRuns } from '../check-fix'
import { runAudit, renderAuditReport } from '../audit'
import { runGate, renderGateReport } from '../gate'

export const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Validate integrity across routes, controllers, pages, and models.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON.',
    },
    routes: {
      type: 'string',
      description: 'Path to routes entry file.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    arch: {
      type: 'boolean',
      description: 'Run only architecture boundary checks (guren.arch.ts). Fast path for edit hooks.',
    },
    docs: {
      type: 'boolean',
      description: 'Run only doc-link checks (docs/ frontmatter + @docs tags).',
    },
    spec: {
      type: 'boolean',
      description: 'Run only spec drift checks (docs/spec/ vs regenerated views).',
    },
    i18n: {
      type: 'boolean',
      description: 'Run only translation catalog checks (lang/<locale> key and placeholder parity).',
    },
    prototype: {
      type: 'boolean',
      description: 'Run only prototype wiring checks (RFC 0021): fixture entries against the route graph.',
    },
    env: {
      type: 'boolean',
      description: 'Run only the check that .env.example lists the keys config/env.ts declares (RFC 0027).',
    },
    plan: {
      type: 'boolean',
      description: 'Run the implementation-plan checks (RFC 0030), which no other run includes: approved plans with drifted elements, and open plans changing the same element. Imports db/schema.ts and the validator files. Advisory: never sets the exit code.',
    },
    changed: {
      type: 'boolean',
      description: 'Restrict file-scanning checks to files changed vs. the merge base with main.',
    },
    // Positive on purpose, so citty's negation lands on this key; `default: true` prints `--no-introspect`.
    introspect: {
      type: 'boolean',
      default: true,
      description: 'Judge from source only, without introspecting the app (RFC 0026).',
    },
    ci: {
      type: 'boolean',
      description: 'Exit non-zero when any check fails or warns (runs the full suite; for CI gates).',
    },
    fix: {
      type: 'boolean',
      description: 'Run the guren command each finding names as its fix (codegen, spec:generate: generated files only), then check again.',
    },
  },
  async run({ args }) {
    // --ci promises a full-suite gate; letting a suite flag narrow the run
    // underneath it would report success while docs/spec/core went unchecked.
    const suiteFlags = CHECK_SUITES.filter((suite) => args[suite])
    if (args.ci && suiteFlags.length > 0) {
      consola.error(ciSuiteConflict(suiteFlags))
      process.exitCode = 1
      return
    }
    if (args.ci && args.fix) {
      consola.error('--fix regenerates the files a --ci gate exists to catch drifting. Run guren check --fix locally and commit what it writes.')
      process.exitCode = 1
      return
    }

    const options = {
      cwd: args.app,
      json: Boolean(args.json),
      routesFile: args.routes,
      arch: Boolean(args.arch),
      introspect: args.introspect !== false,
      docs: Boolean(args.docs),
      spec: Boolean(args.spec),
      i18n: Boolean(args.i18n),
      prototype: Boolean(args.prototype),
      env: Boolean(args.env),
      plan: Boolean(args.plan),
      changed: Boolean(args.changed),
    }
    let report = await runCheck(options)
    if (args.fix) {
      let fixes = await runCheckFixes(report)
      if (fixes.length > 0) {
        report = (await recheckInChild(options, report.cwd)) ?? (await runCheck(options))
        fixes = settleFixRuns(fixes, report)
      }
      report.fixes = fixes
      if (fixes.some((run) => !run.ok)) process.exitCode = 1
    }

    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      renderCheckReport(report)
    }

    // Only the suite flags and the opt-in `--ci` gate on exit code. Plain
    // `guren check` has never set one, and changing that on a v1.0-stable
    // command is a breaking change reserved for a major release.
    if (suiteFlags.length > 0 && report.failCount > 0) {
      process.exitCode = 1
    }
    if (args.ci && gatingResults(report).length > 0) {
      process.exitCode = 1
    }
  },
})

export const gateCommand = defineCommand({
  meta: {
    name: 'gate',
    description:
      'Run every verification stage the CI runs (codegen, typecheck, lint, check, audit, test) and exit non-zero if any fails.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON.',
    },
    changed: {
      type: 'boolean',
      description: 'Narrow check and lint to files changed vs. the merge base with main (typecheck, audit, and test still run in full).',
    },
    deps: {
      type: 'boolean',
      description: 'Scan dependencies in the audit stage via bun audit (requires registry access).',
    },
    routes: {
      type: 'string',
      description: 'Path to routes entry file.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    const report = await runGate({
      cwd: args.app,
      changed: args.changed,
      deps: args.deps,
      routesFile: args.routes,
    })

    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      renderGateReport(report)
    }

    if (!report.ok) {
      process.exitCode = 1
    }
  },
})

export const auditCommand = defineCommand({
  meta: {
    name: 'audit',
    description: 'Run a security audit: validation, authentication, raw SQL, secrets, mass assignment, dependency vulnerabilities.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON.',
    },
    routes: {
      type: 'string',
      description: 'Path to routes entry file.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    'audit-config': {
      type: 'string',
      description: 'Path to the ignore config (defaults to config/audit.{ts,js,mjs}).',
    },
    deps: {
      type: 'boolean',
      default: true,
      description: 'Scan dependencies via bun audit (requires registry access). Disable with --no-deps.',
    },
    // Same shape as check's `introspect` flag above.
    introspect: {
      type: 'boolean',
      default: true,
      description: 'Judge routes from the routes file only, without introspecting the app (RFC 0026).',
    },
  },
  async run({ args }) {
    const report = await runAudit({
      cwd: args.app,
      routesFile: args.routes,
      auditConfigFile: args['audit-config'],
      deps: args.deps,
      introspect: args.introspect !== false,
    })

    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      renderAuditReport(report)
    }

    if (report.failCount > 0) {
      process.exitCode = 1
    }
  },
})
