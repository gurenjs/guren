---
'@guren/plugin-lambda': minor
---

Add the `dynamodb` session driver and its table (RFC 0020 Part 4)

`registerDynamoDbSessionDriver(manager)` adds a `dynamodb` driver whose store
keeps `{ id, data, expires_at }` items, for Lambda apps that want session churn
off the primary database. `@aws-sdk/client-dynamodb` is an optional peer,
imported on first use.

Two details are the contract rather than tuning. Reads are strongly consistent:
a session written at login must be readable on the redirect that follows, which
is the guarantee that rules key-value stores out. And `touch` carries
`attribute_exists(id) AND expires_at > :now` — a bare `UpdateItem` creates the
item, so without it refreshing a destroyed session would resurrect it empty.
`read` also compares `expires_at` itself, because DynamoDB's TTL deletes within
48 hours of expiry rather than at it.

The CDK construct gains `sessionsTable`, which provisions that table with TTL
on `expires_at` and grants every function read/write plus
`DYNAMODB_SESSIONS_TABLE`. It retains the table on `cdk destroy` unless
`retainOnDelete: false` is passed: deleting it logs every user out.

`@guren/server` is now an optional peer dependency. The `SessionDrivers`
augmentation has to name the module that declares the interface, and
`@guren/core` re-exports it rather than declaring it — but every use in the
plugin's shipped code is `import type`, so a peer is what resolves the
declarations without adding an install.
