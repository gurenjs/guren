---
"@guren/cli": patch
---

A plan whose added parent model declares a relationship to a model a later task adds (a `hasMany` to a child listed after it) no longer stalls at the parent's `data` step. `plan:status` judges a relationship that waits on a later task's work (its target's class, the target's foreign key, or a `belongsToMany` pivot) on the model it waits on, as `relationship <Model>.<name>`, at the step owning that model, and notes on the parent where it is judged. `plan:scaffold` names that step beside the relationship it leaves out (`judgedAt`), and `plan:next` lists the relationship under the target's step.
