---
'@guren/plugin-agents': minor
---

Retry a call automatically once a human approves it (RFC 0017 Part 3)

A tool declaring `approval: 'required'` refuses the first call and files a
request for a human, and until now an agent got the request id and was on its
own. The approval queue cannot help: it stores only redacted input and a
non-reversible fingerprint, so it can neither return the arguments nor repeat
the call.

`GurenAgent` now owns the retry material. A parked call is checkpointed into a
private table in the agent's own Durable Object SQLite before the result is
returned, and a `checkPendingApprovals` schedule is created — 30 seconds,
doubling per check, capped at the request's expiry. On each wake the agent asks
the queue about every parked call: `approved` repeats the original call with the
stored arguments, so the queue's consume-on-use and fingerprint match spend
exactly the approval that was granted; `rejected` and `expired` rows are pruned.

```ts
export class Ops extends GurenAgent<Env, OpsState> {
  async retire(id: number) {
    const result = await this.tools.call('posts.destroy', { id })
    if (result.pending) return   // parked; the retry is scheduled for you
  }

  onToolApprovalSettled(event: AgentToolApprovalSettled) {
    if (event.status === 'approved') { /* event.result holds the retry's answer */ }
  }
}
```

- **`onToolApprovalSettled(event)`** is overridable and a no-op by default.
  `status` is the approval's outcome (`approved`, `rejected`, `expired`, or
  `unknown` for a request the queue no longer has); `result` is the retry's own
  answer, which can itself be a refusal when another caller spent the approval
  first.
- **A lapsed row is asked about once before it goes.** A human can answer
  between the last check and the wake that finds the row past its expiry, and
  pruning it unread would report that answer as `expired` — an application that
  remembers only rejections then puts the same question to the same person on
  its next sweep. The sweep now settles such a row as `rejected` when the queue
  says so, and as `expired` otherwise: an approval past `expiresAt` is unusable,
  so there is nothing left to retry either way.
- **Nothing is held in memory.** State and schedules are both durable, so an
  eviction between the request and the approval loses nothing.
- **No encrypter, no ledger.** Ledger rows are encrypted with the app key at
  rest, which is what makes holding raw arguments acceptable at all. An
  application without `EncryptionServiceProvider` and `APP_KEY` is warned at
  boot and gets no ledger: a parked call is still reported with its `requestId`,
  it is simply never retried automatically.
- **The sweep cannot throw.** The Agents SDK retries a failed scheduled callback
  three times and then drops the schedule, so one bad row would replay the whole
  sweep and then leave every surviving row with no wake at all. Each row is
  handled on its own, a hook that throws is reported and swallowed, a row naming
  a route a deploy removed is kept and counted, and a row no current key can
  decrypt is pruned and reported as `status: 'unreadable'` rather than taking
  down the sweep — and with it the record path, which reads the same rows to
  pick its next wake.
- **An approval found already spent settles without calling anything.** If a
  sweep is interrupted after the retry ran but before its row was cleared, the
  next one settles with `status: 'approved'` and no `result`. Repeating the call
  there would file a fresh request, page a human again, and perform the action
  twice.
- **A retry refused for want of budget keeps its row**, rather than spending a
  human's approval on a rate-limit refusal.
- **`AgentToolClient.status(requestId)`** answers what `guren.approval_status`
  answers an MCP client, derived by the same rule, metered against the same
  per-instance budget, and audited under the same tool name. It reports "the
  queue has no such request for you" and "the queue could not be asked" as
  distinct outcomes, because a caller that purged its retry material on an
  unanswerable check would drop arguments a later approval needs.
