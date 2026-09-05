import { GurenAgent } from '../../../../../src/agent'
import type { AgentToolCallResult } from '../../../../../src/index'

/** Registered with a budget small enough that a retry runs out of it. */
export class ThriftyAgent extends GurenAgent<Cloudflare.Env, Record<string, never>> {
  initialState: Record<string, never> = {}

  async destroyPost(id: number): Promise<AgentToolCallResult> {
    return this.tools.call('posts.destroy', { id })
  }
}
