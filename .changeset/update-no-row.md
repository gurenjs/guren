---
'@guren/orm': patch
---

`Model.update()` and `Model.forceUpdate()` resolve to `undefined` when the condition matches no row, whatever the model declares. A model with `casts` threw `TypeError: record is not an Object` there, and a model with only `accessors` resolved to an object holding the accessors computed from nothing (`{ shout: 'undefined!' }`), which an `if (!post)` check read as a record that was found. The `updated` and `saved` hooks and observers no longer run for an update that changed no row; they were called with `undefined`.
