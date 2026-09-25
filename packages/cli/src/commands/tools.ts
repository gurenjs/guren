import { defineCommand, keepsProcessAlive } from '../define-command'
import { displayToolInspection, displayTools } from '../tool-list'
import { runToolCall } from '../tool-call'
import { runToolLog } from '../tool-log'
import { runTokenIssue } from '../token-issue'
import { runToolDev } from '../tool-dev'

export const toolListCommand = defineCommand({
  meta: {
    name: 'tool:list',
    description: 'List the agent tools this application exposes (RFC 0016).',
  },
  args: {
    routes: {
      type: 'string',
      description: 'Path to the routes entry file',
      valueHint: 'routes/web.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output the derived tools as JSON',
    },
  },
  async run({ args }) {
    await displayTools({ routesFile: args.routes, appRoot: args.app, json: args.json })
  },
})

export const toolInspectCommand = defineCommand({
  meta: {
    name: 'tool:inspect',
    description: 'Show one agent tool as it is derived: input, output, authorization, annotations.',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Tool name (defaults to the route name)',
      required: true,
    },
    routes: {
      type: 'string',
      description: 'Path to the routes entry file',
      valueHint: 'routes/web.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output the derived tool as JSON',
    },
  },
  async run({ args }) {
    await displayToolInspection(args.name, {
      routesFile: args.routes,
      appRoot: args.app,
      json: args.json,
    })
  },
})

export const toolCallCommand = defineCommand({
  meta: {
    name: 'tool:call',
    description: 'Invoke one agent tool against this application, the way an agent would (RFC 0016).',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Tool name, as tool:list prints it',
      required: true,
    },
    input: {
      type: 'string',
      description: 'Tool arguments as a JSON object',
      valueHint: '{"title":"Hello"}',
    },
    as: {
      type: 'string',
      description:
        'Authenticate as a user (user:42). Development only: sets GUREN_TESTING=1 for this process, '
        + 'which makes the app accept an injected user instead of a real credential',
      valueHint: 'user:42',
    },
    preflight: {
      type: 'boolean',
      description: 'Ask for a verdict instead of an execution — the handler does not run',
    },
    // No `--routes`: this command dispatches into the booted application, so its
    // tools come from the graph that app actually serves — see `tool-call.ts`.
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output the call result as JSON',
    },
  },
  async run({ args }) {
    await runToolCall({
      name: args.name,
      input: args.input,
      as: args.as,
      preflight: Boolean(args.preflight),
      appRoot: args.app,
      json: Boolean(args.json),
    })
  },
})

// Reads the trail the MCP plugin's `audit` sink writes. Boots nothing: an audit
// trail has to be readable when the application it records is not startable.
export const toolLogCommand = defineCommand({
  meta: {
    name: 'tool:log',
    description: 'Read this application\'s agent audit trail (RFC 0016).',
  },
  args: {
    file: {
      type: 'string',
      description: 'Base path of the audit trail; dated files sit beside it',
      valueHint: 'storage/logs/agent-audit.log',
    },
    tail: {
      type: 'boolean',
      alias: 'f',
      description: 'Follow the trail as records arrive, across the midnight rollover',
    },
    tool: {
      type: 'string',
      description: 'Only records for this tool',
      valueHint: 'posts.store',
    },
    surface: {
      type: 'string',
      description: 'Only records from this surface (mcp, dev-mcp, cli, webmcp, durable, in-process)',
      valueHint: 'mcp',
    },
    denied: {
      type: 'boolean',
      description: 'Only denials',
    },
    since: {
      type: 'string',
      description: 'Only records newer than this duration ago',
      valueHint: '30m',
    },
    number: {
      type: 'string',
      alias: 'n',
      description: 'How many records to show (default 50)',
      valueHint: '50',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output one raw record per line, for piping',
    },
  },
  async run({ args }) {
    const rawNumber = args.number
    await runToolLog({
      file: args.file,
      tail: Boolean(args.tail),
      tool: args.tool,
      surface: args.surface,
      denied: Boolean(args.denied),
      since: args.since,
      limit: rawNumber === undefined ? undefined : parseRecordCount(rawNumber),
      appRoot: args.app,
      json: Boolean(args.json),
    })
  },
})

/**
 * Read `-n` as a count. A `string` arg rather than citty's `number`: citty hands
 * `--number abc` across as `NaN`, every comparison against it is false, and the
 * empty listing reads as "no agent calls happened".
 */
function parseRecordCount(raw: string): number {
  const count = Number(raw)
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`-n must be a positive whole number of records — received "${raw}".`)
  }
  return count
}

// `token:` is its own namespace: this one writes into the application's store,
// so unlike its `tool:` neighbours it boots the app.
export const tokenIssueCommand = defineCommand({
  meta: {
    name: 'token:issue',
    description: 'Issue an API token scoped to this application\'s agent tools (RFC 0016).',
  },
  args: {
    name: {
      type: 'string',
      description: 'Human-readable token name',
      required: true,
    },
    user: {
      type: 'string',
      description: 'User ID the token authenticates as',
      required: true,
    },
    tools: {
      type: 'string',
      description: 'Comma-separated tool scopes (tools:read, posts.*, posts.store, tools:*)',
      required: true,
    },
    'read-only': {
      type: 'boolean',
      description: 'Grant only read-only tools, stored as concrete tool: entries',
    },
    expires: {
      type: 'string',
      description: 'Expiry as 30d, 12h or 45m (omit to issue a non-expiring token)',
    },
    'allow-unmatched': {
      type: 'boolean',
      description: 'Accept a scope matching no current tool, granting it to tools added later',
    },
    yes: {
      type: 'boolean',
      description: 'Confirm a tools:* grant',
    },
    routes: {
      type: 'string',
      description: 'Path to the routes entry file',
      valueHint: 'routes/web.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output the issued token as JSON',
    },
  },
  async run({ args }) {
    // What last-wins buys here, on a command that mints credentials:
    // `--yes=false --yes=false` would authorize a `tools:*` grant the user
    // twice declined (`define-command.ts`).
    const name = args.name
    const user = args.user
    const tools = args.tools
    if (name === undefined || user === undefined || tools === undefined) {
      throw new Error('token:issue requires --name, --user and --tools.')
    }

    await runTokenIssue({
      name,
      user,
      tools,
      readOnly: Boolean(args['read-only']),
      allowUnmatched: Boolean(args['allow-unmatched']),
      yes: Boolean(args.yes),
      expires: args.expires,
      routesFile: args.routes,
      appRoot: args.app,
      json: Boolean(args.json),
    })
  },
})

// This command *is* the server: it ends when the developer stops it, which is
// when the token stops existing.
export const toolDevCommand = keepsProcessAlive(defineCommand({
  meta: {
    name: 'tool:dev',
    description: 'Serve this application\'s agent tools locally with a throwaway token (RFC 0016).',
  },
  args: {
    as: {
      type: 'string',
      description: 'User ID tool calls authenticate as (default: a placeholder matching no record)',
    },
    path: {
      type: 'string',
      description: 'Endpoint path, if the app mounted the MCP plugin somewhere other than /mcp',
      valueHint: '/mcp',
    },
    port: {
      type: 'string',
      description: 'Port to listen on (default 3333)',
    },
    host: {
      type: 'string',
      description: 'Hostname to bind (default 127.0.0.1)',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
  },
  async run({ args }) {
    // Decimal digits and nothing else: `parseInt` stops at the first non-digit
    // so `3333abc` would bind 3333, and `Number` turns `--port=`, `0x10` and
    // `1e3` into real ports nobody asked for.
    const rawPort = args.port
    const port = rawPort === undefined ? undefined : Number(rawPort)
    if (
      rawPort !== undefined
      && (!/^\d+$/u.test(rawPort.trim()) || port === undefined || port > 65535)
    ) {
      throw new Error(`Invalid --port value "${rawPort}". Use a port number between 0 and 65535.`)
    }

    await runToolDev({
      as: args.as,
      path: args.path,
      port,
      hostname: args.host,
      appRoot: args.app,
    })
  },
}))
