/**
 * The notification an application sends its approvers when an agent tool call
 * becomes a pending approval request (RFC 0016 §5.4 item 4).
 *
 * A ready-made {@link Notification} rather than a message the adapter composes,
 * so "notify approvers through the existing notifications system" is one line
 * in an application's configuration:
 *
 * ```typescript
 * mcpPlugin({
 *   approvals: {
 *     store,
 *     notify: (request) => notifications.sendToMany(admins, new AgentApprovalRequested(request)),
 *   },
 * })
 * ```
 *
 * **Who the approvers are is never the framework's decision**, which is why
 * this class takes a request and not a recipient. The plugin hands the request
 * over; the application picks who hears about it, over which channels, with
 * whatever escalation it already has. An adapter that chose recipients would be
 * choosing them from a list it cannot see.
 *
 * Deliberately in its own module, and deliberately not imported by
 * `approval.ts`: the store interface and its derivations stay declaration-only
 * and free of the notifications subsystem, so a runtime that never notifies
 * never pulls it into the graph.
 *
 * Not queued (`shouldQueue` stays false). An approval request is answered by a
 * human in the next few minutes or it expires, and a queue worker that is
 * behind — or absent, which is the common case in the small deployments this
 * endpoint targets — turns "notify approvers" into "notify approvers
 * eventually", after the window closed.
 */
import { Notification } from '../notifications/Notification'
import type { Notifiable, NotificationMailMessage, SlackMessage } from '../notifications/types'
import type { AgentApprovalRequest } from './approval'

export class AgentApprovalRequested extends Notification {
  constructor(public readonly request: AgentApprovalRequest) {
    super()
  }

  /**
   * Mail and database by default — the two channels an application configures
   * first, and the pair that covers "tell someone now" and "there is a list of
   * things waiting". An application overrides by subclassing, exactly as it
   * would for any other notification.
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
   * The record's own fields, minus the fingerprint.
   *
   * The fingerprint is a hash of the *raw* arguments (see `approval.ts`), and
   * a database notification is read by more people, and kept longer, than the
   * approval store itself. It decides nothing an approver looks at: the
   * arguments they judge are `input`, already masked.
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
