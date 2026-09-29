import { defineCommand } from '../define-command'
import { markCommandFailed } from '../command-status'
import { isCompleteGraph, type GraphResult } from '../application-graph'
import { loadApplicationGraph } from '../application-graph-load'
import { GRAPH_OUTPUT_LIMIT } from '../application-graph-fresh'

export const graphCommand = defineCommand({
  meta: { name: 'graph', description: 'Read the application graph with coverage and source evidence (RFC 0032).' },
  args: {
    json: { type: 'boolean', description: 'Print the versioned graph JSON.' },
    app: { type: 'string', description: 'Application root directory.' },
    introspect: { type: 'boolean', default: true, description: 'Disable registration introspection with --no-introspect.' },
  },
  async run({ args }) {
    let result: GraphResult
    try {
      result = await loadApplicationGraph({ cwd: args.app ?? process.cwd(), introspect: args.introspect !== false })
    } catch {
      result = { schemaVersion: 1, error: { code: 'collection-failed', message: 'Application graph collection could not complete.' } }
    }
    let encoded = JSON.stringify(result)
    if (Buffer.byteLength(encoded) > GRAPH_OUTPUT_LIMIT) {
      result = { schemaVersion: 1, error: { code: 'output-limit', message: 'Application graph exceeds the 8 MiB output limit.' } }
      encoded = JSON.stringify(result)
    }
    if (!isCompleteGraph(result)) markCommandFailed()
    console.log(args.json ? encoded : 'error' in result ? result.error.message
      : `${result.nodes.length} nodes, ${result.edges.length} edges; snapshot ${result.snapshot.id}\n${Object.entries(result.coverage).map(([key, value]) => `${key}: ${value.status}`).join('\n')}`)
  },
})
