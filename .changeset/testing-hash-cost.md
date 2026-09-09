---
'@guren/server': minor
---

`DefaultHasher` (the hasher behind `Hash`, `AuthenticatableModel` and `ModelUserProvider`) hashes with cheap parameters while `GUREN_TESTING` is set — Argon2id at 1 MiB / 1 iteration on Bun, scrypt at N=1024 elsewhere — instead of the production defaults. `TestApp` sets that variable, so a test that creates a user no longer pays ~136 ms per password; a 68-test suite that took 8.3 s runs in 0.6 s. Verification is unchanged: it reads the parameters the stored hash carries.
