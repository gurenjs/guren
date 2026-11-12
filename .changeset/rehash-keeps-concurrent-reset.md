---
'@guren/server': patch
---

The rehash `ModelUserProvider` writes at login is keyed on the hash it verified as well as the user id. A password reset that lands between the read and the rehash keeps its hash; before, the rehash wrote over it and the old password worked again. The provider reads the row back after the write, so of two logins that rehash the same account at once, the one whose write matched nothing binds its session to the hash that was stored.
