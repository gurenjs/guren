import { defineModel } from '@guren/orm'

import { agentApprovals } from '../../db/schema'

/**
 * A request is only ever *answered* through the operator API. Everything that
 * identifies the call — tool, input, fingerprint, principal — is written once
 * by the queue and is not mass-assignable.
 */
export class AgentApproval extends defineModel(agentApprovals, {
  fillable: ['status', 'resolvedAt', 'resolvedBy', 'consumedAt'],
}) {}
