---
"@guren/orm": minor
---

`toDrizzle()` without an argument no longer throws on SQLite while another request holds a transaction open. Awaiting the query now waits for that transaction to settle, like the model's own reads and writes (a statement from `.prepare()` too), and a query awaited inside the transaction's callback runs on it instead of throwing. The synchronous `.all()`, `.get()`, `.run()` and `.values()` still throw during another request's transaction, since they cannot wait. Adapters gain an optional `queueExecution()` hook for this.
