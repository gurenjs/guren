---
'@guren/server': patch
---

The rehash `ModelUserProvider` writes at login is keyed on the hash it verified as well as the user id. A password reset that lands between the read and the rehash keeps its hash; before, the rehash wrote over it and the old password worked again.
