---
'@guren/server': patch
---

A failed query no longer exposes its bound parameters: the values drizzle appends after `params:` in a query error (and the statement mysql2 formats them into) are replaced by `[redacted N values]` in the debug JSON body, the debug page, the `/health` report, the fallback `Unhandled exception` log, registered exception reporters, the scheduler, queue and broadcast logs, and every queue driver's stored failed-job record, across the error's whole cause chain. The SQL text stays, so a failed INSERT still shows which statement broke without printing the password hash it carried.
