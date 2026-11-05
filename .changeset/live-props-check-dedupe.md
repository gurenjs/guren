---
'@guren/cli': patch
---

`guren check` reports an unpinned event once per action. Two `live()` props of one action listening for the same event used to give two `live-props:event-name` warnings with the same key.
