---
'@guren/cli': minor
---

`guren context <Entity>` finds the routes of controllers that are not named after the entity. A route now belongs to the bundle when its action body uses the model class imported from the model's file (`User.create(...)`, an aliased import included) or passes a record type from that file to `this.auth` (`this.auth.userOrFail<UserRecord>()`), in addition to the `<Entity>Controller` name and a `bind` naming the model. Each route in `--json` carries `linkedBy` (`controller`, `binding` or `reference`), and the pages those actions render join the Pages section. A controller route whose action body cannot be read is listed under `unverifiedRoutes` instead of being left out without a word.

The model section now shows `fillable`, `hidden`, `visible` and `casts`, and `guren model:list --format json` includes the same four fields. Each is `null` when the model does not declare it and `"unreadable"` when it is declared with a value a static read cannot follow, such as a constant defined elsewhere.
