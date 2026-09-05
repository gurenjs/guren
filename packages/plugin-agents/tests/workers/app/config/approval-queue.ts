/**
 * The approval queue the workerd suite plays a human against.
 *
 * Its own module for the reason `routing-switch.ts` is one: `config/agents.ts`
 * and `src/app.ts` both need it, and the app imports the config. In the
 * isolate's memory, which is enough here because a Durable Object and the
 * Worker entrypoint share one module instance — a deployed app needs a store
 * its next isolate can read.
 */
import type {
  AgentApprovalMatch,
  AgentApprovalRequest,
  AgentApprovalStore,
} from '@guren/core'

class MemoryApprovalStore implements AgentApprovalStore {
  readonly records: AgentApprovalRequest[] = []
  /** Lookups left to fail, so a test can drive the unanswerable-check path. */
  failLookups = 0

  async create(request: AgentApprovalRequest): Promise<void> {
    this.records.push(request)
  }

  async find(id: string): Promise<AgentApprovalRequest | null> {
    if (this.failLookups > 0) {
      this.failLookups -= 1
      throw new Error('the queue is unreachable')
    }
    return this.records.find((record) => record.id === id) ?? null
  }

  async findMatch(match: AgentApprovalMatch): Promise<AgentApprovalRequest | null> {
    const matched = this.records.filter(
      (record) =>
        record.tool === match.tool
        && record.fingerprint === match.fingerprint
        && record.principalKey === match.principalKey
        && record.consumedAt === undefined,
    )
    return matched[matched.length - 1] ?? null
  }

  /** Compare-and-set, so two concurrent calls cannot both win one approval. */
  async consume(id: string): Promise<boolean> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record || record.consumedAt !== undefined) return false
    record.consumedAt = new Date().toISOString()
    return true
  }
}

export const approvalQueue = new MemoryApprovalStore()
