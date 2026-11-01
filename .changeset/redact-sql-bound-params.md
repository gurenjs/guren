---
'@guren/server': patch
---

A failed query no longer exposes its bound parameters: the values drizzle appends after `params:` in a query error are replaced by `[redacted N values]` in the debug JSON body, the debug page, the fallback `Unhandled exception` log, registered exception reporters, the queue's failure logs and stored failed-job records, across the error's whole cause chain. The SQL text stays, so a failed INSERT still shows which statement broke without printing the password hash it carried.
