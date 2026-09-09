---
"@guren/testing": patch
---

Admit vitest 5 in the optional `vitest` peer range. `@guren/testing/vitest` runs unchanged on 5.0: the hooks it wires (`beforeEach`/`afterEach`, `vi.doMock`) kept their contract, and the suites of the reference apps pass on it.
