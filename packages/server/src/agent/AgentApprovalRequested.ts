/**
 * The notification an application sends its approvers when an agent tool call
 * becomes a pending approval request (RFC 0016 §5.4 item 4).
 *
 * Takes a request, not a recipient: who the approvers are is never the
 * framework's decision. Deliberately unimported by `approval.ts`, so a runtime
 * that never notifies does not pull the notifications subsystem into its graph.
 * Not queued (`shouldQueue` stays false): an approval is answered within minutes
 * or expires, and a worker that is behind notifies after the window closed.
 */
import { Notification } from '../notifications/Notification'
import type { Notifiable, NotificationMailMessage, SlackMessage } from '../notifications/types'
import type { AgentApprovalRequest } from './approval'

export class AgentApprovalRequested extends Notification {
  constructor(public readonly request: AgentApprovalRequest) {
    super()
  }

  /**
   * Mail and database by default — "tell someone now" and "there is a list of
   * things waiting". An application overrides by subclassing.
   */
  via(_notifiable: Notifiable): string[] {
    return ['mail', 'database']
  }

  toMail(_notifiable: Notifiable): NotificationMailMessage {
    const who = describePrincipal(this.request)
    return {
      subject: `Approval needed: ${this.request.tool}`,
      text:
        `${who} asked to run the agent tool "${this.request.tool}". Nothing has been executed.\n\n`
        + `Request id: ${this.request.id}\n`
        + `Requested at: ${this.request.requestedAt}\n`
        + `Expires at: ${this.request.expiresAt}\n\n`
        + `Arguments (sensitive fields masked):\n${JSON.stringify(this.request.input, null, 2)}\n`,
    }
  }

  /**
   * The record's own fields, minus the fingerprint: that is a hash of the *raw*
   * arguments (see `approval.ts`), while a database notification is read by
   * more people and kept longer. The arguments an approver judges are `input`,
   * already masked.
   */
  toDatabase(_notifiable: Notifiable): Record<string, unknown> {
    return {
      requestId: this.request.id,
      tool: this.request.tool,
      input: this.request.input,
      principal: this.request.principal,
      requestedAt: this.request.requestedAt,
      expiresAt: this.request.expiresAt,
    }
  }

  toSlack(_notifiable: Notifiable): SlackMessage {
    return {
      text:
        `Approval needed: *${this.request.tool}* requested by ${describePrincipal(this.request)}. `
        + `Nothing was executed. Request \`${this.request.id}\` expires at ${this.request.expiresAt}.`,
    }
  }
}

/** The requester, in the vocabulary an approver reads rather than a key. */
function describePrincipal(request: AgentApprovalRequest): string {
  const { principal } = request
  if (!principal) return 'An unidentified caller'
  return `${principal.kind === 'service' ? 'Service' : 'User'} ${String(principal.id)}`
}
