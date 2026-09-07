import { Controller } from '@guren/core'

import { listApprovals, operatorName, resolveApproval } from '../../Services/approvals'
import { approvalStore } from '../../Services/DrizzleApprovalStore'
import {
  ApprovalIdParamSchema,
  PruneApprovalsSchema,
  ResolveApprovalSchema,
} from '../Validators/ApprovalValidator'

/** How old a settled request must be before `prune` removes it, by default. */
const PRUNE_AFTER_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export default class ApprovalController extends Controller {
  async index(): Promise<Response> {
    return this.json(await listApprovals())
  }

  async approve(): Promise<Response> {
    return this.resolve('approved')
  }

  async reject(): Promise<Response> {
    return this.resolve('rejected')
  }

  /**
   * Housekeeping an operator asks for. Nothing prunes on its own: a request is
   * this application's audit trail of what an agent was allowed to do.
   */
  async prune(): Promise<Response> {
    const { olderThanDays } = await this.validateBody(PruneApprovalsSchema)
    const before = new Date(Date.now() - (olderThanDays ?? PRUNE_AFTER_DAYS) * DAY_MS)

    return this.json({
      pruned: await approvalStore.pruneSettled(before),
      before: before.toISOString(),
    })
  }

  private async resolve(status: 'approved' | 'rejected'): Promise<Response> {
    const { id } = this.validateParams(ApprovalIdParamSchema)
    await this.validateBody(ResolveApprovalSchema)

    const principal = await this.auth.userOrFail<{ id: number; name?: string }>()
    const outcome = await resolveApproval(id, status, await operatorName(principal))

    if (!outcome.ok) {
      return this.json({ error: outcome.message, status: outcome.status }, { status: outcome.httpStatus })
    }
    return this.json({ approval: outcome.approval })
  }
}
