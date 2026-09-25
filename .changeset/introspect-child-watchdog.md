---
'@guren/cli': patch
---

The introspection child no longer outlives the CLI when the app it loads computes synchronously without yielding. A thread of its own now ends the child once its parent is gone, and past a budget two seconds beyond the parent's timeout, where the stdin watch could not fire under a starved event loop and an orphaned child spun at full CPU until killed by hand.
