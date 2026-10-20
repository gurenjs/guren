import { defineCommand } from 'citty'
import { detectCloudflareBackend } from './backend'
import { buildCloudflareOutput } from './build'
import { hasBlocker, planCloudflareDeploy } from './deploy/deploy'
import { formatPlan } from './deploy/report'
import { printBundleReport, reportBundleSize } from './bundle-size'

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
    description: 'Assemble a Cloudflare Workers deployment (.cloudflare/) from the app build',
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
    if (args['report-size'] && detectCloudflareBackend(rootDir) === 'cf') {
      throw new Error('Cloudflare build: --report-size measures through wrangler.jsonc, and this app deploys through cf. Drop the flag; `cf build` writes the bundle to .cloudflare/output/.')
    }
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
      'Plan a deploy through the cf CLI: build, evaluate cloudflare.config.ts, and resolve every D1/KV binding against the account (RFC 0035; only --plan for now)',
  },
  args: {
    root: rootArg,
    plan: {
      type: 'boolean',
      description: 'Stop after the plan, writing nothing to the account (required in this version)',
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
      description: 'Print { plan } as one JSON object',
    },
    'mcp-oauth': {
      type: 'boolean',
      description: 'Build with --mcp-oauth, which binds OAUTH_KV',
    },
    'skip-app-build': {
      type: 'boolean',
      description: "Skip running the app's build script",
    },
  },
  async run({ args }) {
    const plan = await planCloudflareDeploy({
      root: args.root || process.cwd(),
      plan: Boolean(args.plan),
      ci: Boolean(args.ci),
      provision: Boolean(args.provision),
      mcpOAuth: Boolean(args['mcp-oauth']),
      skipAppBuild: Boolean(args['skip-app-build']),
    })

    console.log(args.json ? JSON.stringify({ plan }, null, 2) : formatPlan(plan))
    if (hasBlocker(plan)) {
      process.exitCode = 1
    }
  },
})

export default {
  'cloudflare:build': cloudflareBuild,
  'cloudflare:size': cloudflareSize,
  'cloudflare:deploy': cloudflareDeploy,
}
