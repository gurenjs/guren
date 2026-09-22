---
"@guren/cli": patch
---

Model relationships are read from the call that registers them. A relationship only its `relationTypes` annotation still names no longer counts as declared, so `guren plan:status` reports a deleted `Post.hasMany(...)` as not declared, and the kind comes from the call rather than from the annotation. Calls in a `static {}` block of the class (`this.hasMany(...)`) are now read, and a `BelongsToRequiredRecord<...>` annotation names its target model like `BelongsToRecord<...>`.
