import { GurenAgent } from '../../../../../src/agent'

interface TestAgentState {
  lastTitle: string | null
  sweeps: number
}

export class TestAgent extends GurenAgent<Cloudflare.Env, TestAgentState> {
  initialState: TestAgentState = { lastTitle: null, sweeps: 0 }

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
    this.setState({ lastTitle: title, sweeps: this.state.sweeps + 1 })
  }
}

function textOf(outcome: { content: Array<{ type: string; text?: string }> }): string {
  return outcome.content.map((part) => part.text ?? '').join('')
}
