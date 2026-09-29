import { defineCommand } from '../define-command'
import { markCommandFailed } from '../command-status'
import { CliError } from '../cli-error'
import { fetchRuntimeErrors } from '../runtime-errors'

export const runtimeErrorsCommand = defineCommand({
  meta: { name: 'runtime:errors', description: 'Read recent errors from an explicitly selected local development server.' },
  args: {
    json: { type: 'boolean', description: 'Print versioned JSON.' },
    url: { type: 'string', required: true, description: 'HTTP loopback origin of the running application.' },
    session: { type: 'string', description: 'Session ID from the previous cursor.' },
    after: { type: 'string', description: 'Sequence from the previous cursor.' },
    limit: { type: 'string', description: 'Maximum events, from 1 to 100 (default 20).' },
  },
  async run({ args }) {
    let result
    try {
      result = await fetchRuntimeErrors(args.url, { sessionId: args.session,
        ...(args.after !== undefined ? { after: Number(args.after) } : {}),
        ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
      })
    } catch { throw new CliError('Expected an HTTP loopback origin and a valid nonnegative cursor / limit from 1 to 100.') }
    if (result.status === 'unavailable') markCommandFailed()
    console.log(args.json ? JSON.stringify(result) : result.status === 'unavailable' ? result.reason
      : `${result.events.length} retained errors; ${result.dropped} dropped\n${result.events.map((event) => `${event.sequence} ${event.method} ${event.route?.pattern ?? '(unresolved route)'} ${event.status}`).join('\n')}`)
  },
})
