import { GurenAgent } from '../../../../../src/agent'
import type { AgentToolApprovalSettled, AgentToolCallResult } from '../../../../../src/index'
import { hookThrows } from '../../config/hook-switch'

/** What `onToolApprovalSettled` saw, flattened into state so a wake can report it. */
interface SettledRecord {
  requestId: string
  tool: string
  status: string
  /** The retry's own answer: `true` executed, `false` refused, `null` no retry. */
  retried: boolean | null
  /** The parked call's arguments, absent for an `'unreadable'` row. */
  args?: Record<string, unknown>
}

interface TestAgentState {
  lastTitle: string | null
  sweeps: number
  settled: SettledRecord[]
}

export class TestAgent extends GurenAgent<Cloudflare.Env, TestAgentState> {
  initialState: TestAgentState = { lastTitle: null, sweeps: 0, settled: [] }

  /** Reached only when the route authorizer let the request through. */
  async onRequest(): Promise<Response> {
    return Response.json({ reached: this.name })
  }

  /** Driven by `this.schedule(...)` + `runDurableObjectAlarm` in the suite. */
  async sweep(): Promise<void> {
    const result = await this.tools.call('posts.index', {})
    const title = result.ok
      ? (JSON.parse(textOf(result.outcome)) as { posts: Array<{ title: string }> }).posts[0]!.title
      : null
    this.setState({ ...this.state, lastTitle: title, sweeps: this.state.sweeps + 1 })
  }

  /** The approval-gated tool, called the way an agent would call it. */
  async destroyPost(id: number): Promise<AgentToolCallResult> {
    return this.tools.call('posts.destroy', { id })
  }

  /** State, because a hook's locals do not survive the wake that fired it. */
  onToolApprovalSettled(event: AgentToolApprovalSettled): void {
    if (hookThrows()) throw new Error('the application hook failed')
    this.setState({
      ...this.state,
      settled: [
        ...this.state.settled,
        {
          requestId: event.requestId,
          tool: event.tool,
          status: event.status,
          retried: event.result ? event.result.ok === true : null,
          ...(event.args ? { args: event.args } : {}),
        },
      ],
    })
  }
}

function textOf(outcome: { content: Array<{ type: string; text?: string }> }): string {
  return outcome.content.map((part) => part.text ?? '').join('')
}
