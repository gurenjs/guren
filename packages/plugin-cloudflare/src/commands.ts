import { defineCommand } from 'citty'
import { buildCloudflareOutput } from './build'
import { runCloudflareDeploy } from './deploy/deploy'
import { initCloudflare } from './init'
import { formatResult } from './deploy/report'
import { assertSizeReportable, printBundleReport, reportBundleSize } from './bundle-size'

const rootArg = {
  type: 'string',
  description: 'App root directory (defaults to the current working directory)',
} as const

const topArg = {
  type: 'string',
  description: 'How many of the largest sources to list (default 10)',
} as const

function topOf(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const cloudflareBuild = defineCommand({
  meta: {
    name: 'cloudflare:build',
    description: 'Assemble a Cloudflare Workers deployment from the app build (.cloudflare/, or .guren/cloudflare/ on the cf backend)',
  },
  args: {
    root: rootArg,
    'skip-app-build': {
      type: 'boolean',
      description: "Skip running the app's build script before assembling output",
    },
    'mcp-oauth': {
      type: 'boolean',
      description:
        'Front the App MCP endpoint with @cloudflare/workers-oauth-provider, scaffold the '
        + 'consent flow, and make the OAUTH_KV binding build-owned (requires @guren/plugin-mcp)',
    },
    'mcp-path': {
      type: 'string',
      description:
        'Path the App MCP endpoint is mounted at, protected as the OAuth apiRoute '
        + '(default /mcp; must match mcpPlugin({ path }))',
    },
    'report-size': {
      type: 'boolean',
      description:
        "After assembling, run wrangler's dry run and print the bundle size with its largest sources "
        + '(what cloudflare:size prints)',
    },
    top: topArg,
  },
  async run({ args }) {
    const rootDir = args.root || process.cwd()
    // Before the build, so a flag that cannot be honoured does not end a good build with an error.
    if (args['report-size']) assertSizeReportable(rootDir)
    await buildCloudflareOutput({
      rootDir,
      skipAppBuild: Boolean(args['skip-app-build']),
      mcpOAuth: Boolean(args['mcp-oauth']),
      // Passed only when given: the default belongs to the option itself, so a CLI
      // caller and a programmatic one agree on what "unset" means.
      ...(args['mcp-path'] ? { mcpPath: args['mcp-path'] } : {}),
    })

    if (args['report-size']) {
      printBundleReport(reportBundleSize({ root: rootDir, top: topOf(args.top) }))
    }
  },
})

const cloudflareSize = defineCommand({
  meta: {
    name: 'cloudflare:size',
    description:
      'Measure the worker bundle wrangler would upload from .cloudflare/ and attribute it to its largest sources',
  },
  args: {
    root: rootArg,
    top: topArg,
  },
  run({ args }) {
    printBundleReport(reportBundleSize({ root: args.root || process.cwd(), top: topOf(args.top) }))
  },
})

const cloudflareDeploy = defineCommand({
  meta: {
    name: 'cloudflare:deploy',
    description:
      'Deploy through the cf CLI (RFC 0035): build, plan every D1/KV binding, migration and secret against the account, then create, migrate and deploy after one confirmation',
  },
  args: {
    root: rootArg,
    plan: {
      type: 'boolean',
      description: 'Stop after the plan, writing nothing to the account',
    },
    yes: {
      type: 'boolean',
      description: 'Apply the plan without asking; a run with no terminal needs this or --ci',
    },
    'skip-migrations': {
      type: 'boolean',
      description: 'Deploy without applying the pending migrations',
    },
    ci: {
      type: 'boolean',
      description: 'Never create a missing resource unless --provision is passed',
    },
    provision: {
      type: 'boolean',
      description: 'Allow creating missing resources even under --ci or without a terminal',
    },
    json: {
      type: 'boolean',
      description: 'Print { plan, created, migrated, deployment, url } as one JSON object',
    },
    'mcp-oauth': {
      type: 'boolean',
      description: 'Build with --mcp-oauth, which binds OAUTH_KV (the plan rebuilds the deployable output, so pass what cloudflare:build gets)',
    },
    'mcp-path': {
      type: 'string',
      description: 'Path the App MCP endpoint is mounted at, as for cloudflare:build --mcp-path',
    },
    'skip-app-build': {
      type: 'boolean',
      description: "Skip running the app's build script",
    },
    'allow-destructive': {
      type: 'boolean',
      description: 'Accept pending destructive migration statements no -- guren:allow-destructive marker covers (still listed)',
    },
    'secrets-file': {
      type: 'string',
      description: 'A dotenv file of secrets for the deploy; the plan reads only the names it assigns',
    },
  },
  async run({ args }) {
    const result = await runCloudflareDeploy({
      root: args.root || process.cwd(),
      plan: Boolean(args.plan),
      yes: Boolean(args.yes),
      skipMigrations: Boolean(args['skip-migrations']),
      ci: Boolean(args.ci),
      provision: Boolean(args.provision),
      mcpOAuth: Boolean(args['mcp-oauth']),
      ...(args['mcp-path'] ? { mcpPath: args['mcp-path'] } : {}),
      skipAppBuild: Boolean(args['skip-app-build']),
      allowDestructive: Boolean(args['allow-destructive']),
      ...(args['secrets-file'] ? { secretsFile: args['secrets-file'] } : {}),
      logToStderr: Boolean(args.json),
    })

    console.log(args.json ? JSON.stringify(result, null, 2) : formatResult(result))
    if (result.stopped === 'blocked' || result.stopped === 'declined' || result.failure) {
      process.exitCode = 1
    }
  },
})

const cloudflareInit = defineCommand({
  meta: {
    name: 'cloudflare:init',
    description:
      'Move the app onto the cf CLI: write cloudflare.config.ts, wrangler.config.ts and config/cloudflare.ts, carrying over what wrangler.jsonc decided',
  },
  args: {
    root: rootArg,
    force: {
      type: 'boolean',
      description: 'Rewrite those files when they exist (otherwise they are left as they are)',
    },
  },
  run({ args }) {
    const result = initCloudflare({ rootDir: args.root || process.cwd(), force: Boolean(args.force) })
    if (result.written.length > 0) console.log(`Cloudflare init: wrote ${result.written.join(', ')}.`)
    if (result.skipped.length > 0) console.log(`Cloudflare init: left ${result.skipped.join(', ')} as they are; --force rewrites them.`)
    for (const carried of result.carried) console.log(`  Carried over from wrangler.jsonc: ${carried}.`)
    for (const warning of result.warnings) console.warn(`  ${warning}`)
    console.log([
      'Next:',
      '  bun add -d cf wrangler@latest      # cf, and the Wrangler 4.136+ it bundles with',
      '  bunx guren cloudflare:deploy --plan  # needs Node 22.18+ as the node on PATH, and `bunx cf auth login`',
    ].join('\n'))
  },
})

export default {
  'cloudflare:init': cloudflareInit,
  'cloudflare:build': cloudflareBuild,
  'cloudflare:size': cloudflareSize,
  'cloudflare:deploy': cloudflareDeploy,
}
