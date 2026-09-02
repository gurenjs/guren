---
'@guren/server': minor
---

Deny a password login against an account that has no password, instead of turning it into a 500.

`ModelUserProvider.validateCredentials()` handed whatever sat in the credential column straight to the hasher. A column holding a sentinel rather than a hash — `passwordHash: 'oauth:...'`, which this repo's own JSDoc, `MassAssignmentException` message, database guide and agent skill all suggest for an OAuth-only account — reached `Bun.password.verify()` and threw. The login came back as a 500 while an unknown address came back as a 401, so the pair of responses told an attacker which addresses belong to OAuth accounts. A null column was already handled; the sentinel was not.

Such a column now means what it says: the account cannot authenticate with a password, so the login is denied. It runs through the same dummy-hash path a null column already took, so the two answers cost the same work and the channel does not reopen as a timing difference. `make:auth --oauth` was never affected — it scaffolds a nullable column — so the reachable population is applications that followed the documented sentinel.

**A value that *claims* a hash format and fails to satisfy it keeps throwing.** That is the other half of the rule and it is deliberate: a truncated or corrupt digest is not a passwordless account, and denying that login in silence would leave nothing to notice the corruption by. `looksLikePasswordHash()` is what separates the two, so the prefixes this check trusts are the same ones the swapped-argument diagnostic trusts.

`DefaultHasher` no longer tells a non-hash value that it "was written by Bun.password". That message is for a genuine Argon2id or bcrypt hash met on a runtime that cannot read it; a sentinel now gets one that says what is actually wrong. `ModelUserProvider` never reaches it, but a direct caller can.
