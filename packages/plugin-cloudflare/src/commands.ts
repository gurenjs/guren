import { defineCommand } from 'citty'
import { buildCloudflareOutput } from './build'

const cloudflareBuild = defineCommand({
  meta: {
    name: 'cloudflare:build',
    description: 'Assemble a Cloudflare Workers deployment (.cloudflare/) from the app build',
  },
  args: {
    root: {
      type: 'string',
      description: 'App root directory (defaults to the current working directory)',
    },
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
  },
  async run({ args }) {
    await buildCloudflareOutput({
      rootDir: args.root || process.cwd(),
      skipAppBuild: Boolean(args['skip-app-build']),
      mcpOAuth: Boolean(args['mcp-oauth']),
      // Passed only when given: the default belongs to the option itself, so a CLI
      // caller and a programmatic one agree on what "unset" means.
      ...(args['mcp-path'] ? { mcpPath: args['mcp-path'] } : {}),
    })
  },
})

export default {
  'cloudflare:build': cloudflareBuild,
}
