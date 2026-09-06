import { Controller, ValidationException } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

// Type-only, and it has to stay that way: `app/Agents/Triager.ts` imports
// `@guren/plugin-agents/agent`, whose graph statically imports
// `cloudflare:workers`. A value import here would drag that into every runtime
// that serves a page, Bun included.
import type { TriagerState } from '../../../Agents/Triager'
import { listApprovals, operatorName, resolveApproval } from '../../../Services/approvals'
import { listTickets } from '../../../Services/tickets'
import { TRIAGER_UNAVAILABLE, triagerStub } from '../../../Services/triager'
import { ApprovalIdParamSchema } from '../../Validators/ApprovalValidator'

/**
 * How many tickets the board renders, newest first. Cloudflare's Free plan
 * allows 50 D1 queries per Worker invocation; one render spends 6 — the session
 * read and its rolling touch, the operator row, this list, and two approval
 * lists. Seven when the session is written back instead of touched, a write
 * being a read plus an update. The agent's report is a DO call, not D1.
 */
const TICKET_LIMIT = 40

export default class ConsoleController extends Controller {
  async index(): Promise<Response> {
    const operator = await this.auth.userOrFail<{ id: number; name: string }>()
    const stub = triagerStub()

    return this.inertia(
      pages.Console,
      {
        operator: operator.name,
        tickets: await listTickets(TICKET_LIMIT),
        approvals: await listApprovals(),
        // The RPC crosses an isolate boundary, so its payload arrives as
        // `unknown`. This cast is where the agent's own state type is asserted back.
        report: stub ? ((await stub.report()) as TriagerState) : null,
        agentNote: stub ? null : TRIAGER_UNAVAILABLE,
      },
      { title: 'Triager console' },
    )
  }

  async approve(): Promise<Response> {
    return this.resolve('approved')
  }

  async reject(): Promise<Response> {
    return this.resolve('rejected')
  }

  /**
   * The button the README's walkthrough presses. The agent does the asking;
   * this only wakes it, and every close it wants still waits on a human.
   */
  async sweep(): Promise<Response> {
    const stub = triagerStub()
    if (!stub) throw ValidationException.withMessages({ sweep: TRIAGER_UNAVAILABLE })

    await stub.sweep()
    return this.redirect('/')
  }

  /**
   * Redirects back either way. A refusal is flashed as a form error rather than
   * a status code: the operator is looking at a page, and the row it names is
   * re-rendered with the verdict the gate will apply.
   */
  private async resolve(status: 'approved' | 'rejected'): Promise<Response> {
    const { id } = this.validateParams(ApprovalIdParamSchema)
    const operator = await this.auth.userOrFail<{ id: number; name?: string }>()
    const outcome = await resolveApproval(id, status, await operatorName(operator))

    if (!outcome.ok) throw ValidationException.withMessages({ approval: outcome.message })
    return this.redirect('/')
  }
}
