---
'@guren/cli': minor
---

`guren plan:render` shows Impact (RFC 0030 §2) on every card that changes something the application already has: the routes, `ApiRoutes` entries, agent tools, relationships, resources, policies, controller actions and tests hanging off it, and, for a column, the controllers, resources and pages that read it on the model's records. The column reads come from a new static scan that follows a record from a query on the model class, `this.model()`, `this.resource` or a record type annotation, counts the column names a query spells and the columns `create`/`update` write, and never reads a comment or a string. Impact is labelled a lower bound: an empty list means nothing was found, and a reader that could not look says so. An altered route or action whose application route publishes an agent tool is now flagged breaking even when the plan does not declare the tool.
