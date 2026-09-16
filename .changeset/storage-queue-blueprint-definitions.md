---
'@guren/cli': minor
---

`guren add storage` and `guren add queue` write `config/storage.ts` and `config/queue.ts` definitions when the app declares its environment in `config/env.ts` and nothing already binds the service (RFC 0027 §2). Queue keeps its job registration in a new `app/Providers/JobsProvider.ts`. Both blueprints now add `STORAGE_DISK` / `QUEUE_CONNECTION` to the env files and declare them, and each definition refuses a disk or driver name it does not declare when the app boots; the queue provider fell back to `sync` for any unknown name. `guren add attachments` recognizes a storage definition and no longer installs the storage blueprint over it.
