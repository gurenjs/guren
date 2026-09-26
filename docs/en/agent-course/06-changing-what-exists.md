# Chapter 6: A Plan That Changes What Exists

The first plan only added things. Registrations cannot: a meetup has to learn about its registrations, its page has to show the seats left, and code you already accepted has to change. This chapter plans that change and approves it. The review gets harder, because now the question is not only "is this right?" but also "what else does it touch?"

**What you'll learn:**

- How a plan marks what it changes (`alter`) apart from what it adds
- How to read **Impact**, the page's list of code that depends on a changed element
- Why approval can warn about an `alter`, and what that warning asks of you

## 1. Ask for the plan

> Plan registrations with the plan-write skill: a signed-in user registers for a meetup and can cancel their own registration. A meetup never takes more registrations than its capacity, and its page shows the seats left.

The agent reads `docs/entities/Meetup.md` from chapter 5 as part of `guren context Meetup`, so it knows the existing rules before it plans against them. Leave one question open this time: what happens when someone registers for a full meetup.

**Without an agent:**

```bash run fallback
mkdir -p docs/plans/registrations
```

<details>
<summary>docs/plans/registrations/plan.json</summary>

```json file=docs/plans/registrations/plan.json fallback
{
  "planVersion": 1,
  "title": "Registrations",
  "summary": "Signed-in users register for a meetup until it is full and cancel their own registration. The meetup page shows the seats left.",
  "locale": "en",
  "scope": {"goals": ["Register for a meetup", "Cancel your own registration", "See the seats left"], "nonGoals": ["Paid tickets", "Registering someone else"]},
  "assumptions": ["The organizer can register for their own meetup"],
  "questions": [
    {
      "id": "Q-full",
      "question": "What happens when someone registers for a full meetup?",
      "options": [
        {"label": "refuse", "consequence": "No row is written and the page says the meetup is full."},
        {"label": "waitlist", "consequence": "A waitlisted registration is written and promoted when someone cancels."}
      ],
      "assumed": "refuse",
      "affects": ["model.registration", "action.registrations.store"]
    }
  ],
  "models": [
    {
      "id": "model.user",
      "change": {"kind": "existing"},
      "name": "User",
      "table": "users",
      "columns": [{"id": "column.user.id", "name": "id", "change": {"kind": "existing"}, "type": "integer", "nullable": false, "unique": false, "index": false, "primaryKey": true}],
      "relationships": [],
      "fillable": []
    },
    {
      "id": "model.meetup",
      "change": {"kind": "alter"},
      "name": "Meetup",
      "table": "meetups",
      "columns": [
        {
          "id": "column.meetup.id",
          "name": "id",
          "change": {"kind": "existing"},
          "type": "integer",
          "nullable": false,
          "unique": false,
          "index": false,
          "primaryKey": true
        }
      ],
      "relationships": [{"name": "registrations", "type": "hasMany", "target": "model.registration"}],
      "fillable": []
    },
    {
      "id": "model.registration",
      "change": {"kind": "add"},
      "name": "Registration",
      "table": "registrations",
      "columns": [
        {
          "id": "column.registration.id",
          "name": "id",
          "change": {"kind": "add"},
          "type": "integer",
          "nullable": false,
          "unique": false,
          "index": false,
          "primaryKey": true
        },
        {
          "id": "column.registration.meetupId",
          "name": "meetupId",
          "columnName": "meetup_id",
          "change": {"kind": "add"},
          "type": "integer",
          "nullable": false,
          "unique": false,
          "index": true,
          "references": {"model": "model.meetup", "column": "id", "onDelete": "cascade"}
        },
        {
          "id": "column.registration.userId",
          "name": "userId",
          "columnName": "user_id",
          "change": {"kind": "add"},
          "type": "integer",
          "nullable": false,
          "unique": false,
          "index": true,
          "references": {"model": "model.user", "column": "id", "onDelete": "cascade"}
        }
      ],
      "relationships": [{"name": "meetup", "type": "belongsTo", "target": "model.meetup"}, {"name": "user", "type": "belongsTo", "target": "model.user"}],
      "fillable": [],
      "indexes": [{"columns": ["meetupId", "userId"], "unique": true}]
    }
  ],
  "controllers": [
    {
      "id": "controller.meetups",
      "change": {"kind": "alter"},
      "className": "MeetupController",
      "actions": [
        {
          "id": "action.meetups.show",
          "change": {"kind": "alter"},
          "name": "show",
          "authorization": {"middleware": []},
          "response": {"kind": "inertia", "view": "view.meetups.show"},
          "rules": ["Pass the signed-in user's registration, if any."]
        }
      ]
    },
    {
      "id": "controller.registrations",
      "change": {"kind": "add"},
      "className": "RegistrationController",
      "actions": [
        {
          "id": "action.registrations.store",
          "change": {"kind": "add"},
          "name": "store",
          "authorization": {"middleware": ["auth"]},
          "response": {"kind": "redirect", "to": "/meetups/:id"},
          "rules": ["The registrant is the signed-in user.", "A full meetup writes no row.", "Registering twice writes no second row."]
        },
        {
          "id": "action.registrations.destroy",
          "change": {"kind": "add"},
          "name": "destroy",
          "authorization": {"middleware": ["auth"], "policy": {"id": "policy.registration", "ability": "delete"}},
          "response": {"kind": "redirect", "to": "/meetups/:meetupId"},
          "rules": []
        }
      ]
    }
  ],
  "routes": [
    {
      "id": "route.meetups.show",
      "change": {"kind": "existing"},
      "method": "GET",
      "path": "/meetups/:id",
      "name": "meetups.show",
      "action": "action.meetups.show",
      "middleware": [],
      "bind": [{"param": "id", "model": "model.meetup"}]
    },
    {
      "id": "route.registrations.store",
      "change": {"kind": "add"},
      "method": "POST",
      "path": "/meetups/:id/registrations",
      "name": "registrations.store",
      "action": "action.registrations.store",
      "middleware": ["auth"],
      "bind": [{"param": "id", "model": "model.meetup"}]
    },
    {
      "id": "route.registrations.destroy",
      "change": {"kind": "add"},
      "method": "DELETE",
      "path": "/registrations/:id",
      "name": "registrations.destroy",
      "action": "action.registrations.destroy",
      "middleware": ["auth"],
      "bind": [{"param": "id", "model": "model.registration"}]
    }
  ],
  "views": [
    {
      "id": "view.meetups.show",
      "change": {"kind": "alter"},
      "page": "meetups/Show",
      "purpose": "Show a meetup with the seats left, and a button to register or cancel.",
      "props": [{"name": "meetup", "type": "Data.Meetup", "resource": "resource.meetup"}, {"name": "registrationId", "type": "number | null"}],
      "actions": [{"label": "Register", "route": "route.registrations.store"}, {"label": "Cancel", "route": "route.registrations.destroy"}],
      "states": {"empty": "The meetup is full."}
    }
  ],
  "resources": [
    {
      "id": "resource.meetup",
      "change": {"kind": "alter"},
      "name": "MeetupResource",
      "model": "model.meetup",
      "fields": [
        {"name": "id", "type": "number"},
        {"name": "title", "type": "string"},
        {"name": "startsAt", "type": "string"},
        {"name": "capacity", "type": "number"},
        {"name": "seatsLeft", "type": "number"}
      ]
    }
  ],
  "policies": [
    {
      "id": "policy.registration",
      "change": {"kind": "add"},
      "name": "RegistrationPolicy",
      "model": "model.registration",
      "abilities": [{"name": "delete", "rule": "The signed-in user made the registration."}]
    }
  ],
  "tasks": [
    {
      "id": "task.registrations",
      "entity": "Registration",
      "summary": "Register until the meetup is full, cancel your own registration, and see the seats left.",
      "covers": [
        "model.meetup",
        "model.registration",
        "controller.registrations",
        "action.meetups.show",
        "route.registrations.store",
        "route.registrations.destroy",
        "view.meetups.show",
        "resource.meetup",
        "policy.registration"
      ],
      "acceptance": [
        {
          "id": "AC-registrations-1",
          "description": "A signed-in user can register for a meetup with seats left.",
          "kind": "success",
          "actor": "user",
          "route": "route.registrations.store",
          "given": ["a meetup with 2 seats exists"],
          "expect": {"status": 303}
        },
        {
          "id": "AC-registrations-2",
          "description": "Registering for a full meetup writes no row.",
          "kind": "state",
          "actor": "user",
          "route": "route.registrations.store",
          "given": ["a meetup with 1 seat and 1 registration exists"],
          "expect": {"status": 303}
        },
        {
          "id": "AC-registrations-3",
          "description": "Registering twice writes no second row.",
          "kind": "state",
          "actor": "user",
          "route": "route.registrations.store",
          "given": ["the user is registered for a meetup"],
          "expect": {"status": 303}
        },
        {
          "id": "AC-registrations-4",
          "description": "A guest cannot register.",
          "kind": "unauthenticated",
          "actor": "guest",
          "route": "route.registrations.store",
          "given": ["a meetup exists"],
          "expect": {"redirect": "/login"}
        },
        {
          "id": "AC-registrations-5",
          "description": "A user cannot cancel someone else's registration.",
          "kind": "forbidden",
          "actor": "user",
          "route": "route.registrations.destroy",
          "given": ["another user's registration exists"],
          "expect": {"status": 403}
        },
        {
          "id": "AC-registrations-6",
          "description": "A guest cannot cancel a registration.",
          "kind": "unauthenticated",
          "actor": "guest",
          "route": "route.registrations.destroy",
          "given": ["a registration exists"],
          "expect": {"redirect": "/login"}
        },
        {
          "id": "AC-registrations-8",
          "description": "A user can cancel their own registration.",
          "kind": "success",
          "actor": "user",
          "route": "route.registrations.destroy",
          "given": ["the user is registered for a meetup"],
          "expect": {"status": 303}
        },
        {
          "id": "AC-registrations-7",
          "description": "The meetup page shows the seats left.",
          "kind": "success",
          "actor": "guest",
          "route": "route.meetups.show",
          "given": ["a meetup with 2 seats and 1 registration exists"],
          "expect": {"status": 200}
        }
      ]
    }
  ]
}
```

</details>

As in chapter 2, chapters 6 and 7 name elements of this reference plan. If you kept your own plan until now, this is the second point to switch: copy the block above over `docs/plans/registrations/plan.json`. That works only if your app also matches the reference at the end of chapter 5, so if you kept your own first plan, keep your own second one too and read the names as examples.

## 2. Add, alter, existing

```bash run
bunx guren plan:render docs/plans/registrations/plan.json
```

Open `docs/plans/registrations/plan.html` and turn on **Changes only**. What remains sorts into three kinds:

| Change | Elements | Meaning |
|---|---|---|
| `add` | `Registration`, `RegistrationController`, two routes, `RegistrationPolicy` | new code, as in the first plan |
| `alter` | `Meetup`, `MeetupResource`, `meetups/Show`, `MeetupController.show` | code that exists and will change |
| `existing` | `User`, the `meetups.show` route | referenced, not touched (hidden by **Changes only**) |

An `alter` says what changes in properties Guren can read back from the code: `Meetup` gains a `registrations` relationship, `MeetupResource` a `seatsLeft` field, `meetups/Show` a `registrationId` prop. That is how the loop knows, later, that the change landed.

## 3. Read Impact

Every `alter` card has an **Impact** list: the code the scanners found depending on that element.

![The MeetupResource card on the review page, marked alter. Its Impact list names the index, show and edit actions of MeetupController, their routes and ApiRoutes entries, the test requests reaching index and edit, and the meetups/Edit, Index and Show pages. Below it, the planned fields end with seatsLeft: number](../../images/agent-course-impact.png)

Read it as a question: **does the plan account for each of these?** Here, `MeetupResource` gains `seatsLeft`, and the resource is used by `index`, `show` and `edit`. Each of them has to give the resource a registration count, or `seatsLeft` breaks on the list and edit pages. The plan changes only `show`; the other two are the agent's to notice in the http step, and yours to check in its commit.

The list is a lower bound. A consumer the scanners cannot see (code building a resource by hand, a raw query) is not on it.

| Check | On the page |
|---|---|
| Each `alter` states its change in a property, not only in prose | the element's card |
| Every consumer in Impact is either covered by the plan or fine as it is | **Impact** |
| Nothing listed under breaking changes surprises you | Needs attention |
| A changed or dropped column says what happens to its rows (`dataMigration`) | the column's card |

This plan changes no column, so it needs no data migration. Chapter 2's checklist still applies on top: `registrations.destroy` sits behind a policy, and `AC-registrations-8` is its success behaviour for the user who made the registration.

## 4. Answer and approve

Answer the question the same way as in chapter 3: pick **refuse** on the page, copy the feedback, and hand it over.

> Apply my review of docs/plans/registrations/plan.json with plan:revise: a full meetup refuses the registration; a waitlist is a later change. Keep both warnings on registrations.store, since any signed-in user may register and the request has no body.

**Without an agent:**

```bash run fallback
bunx guren plan:revise docs/plans/registrations/plan.json --ops - <<'EOF'
{
  "ops": [
    {"op": "remove", "id": "Q-full", "reason": "Answered: a full meetup refuses the registration."},
    {"op": "modify", "section": "plan", "element": {"title": "Registrations", "summary": "Signed-in users register for a meetup until it is full and cancel their own registration. The meetup page shows the seats left.", "scope": {"goals": ["Register for a meetup", "Cancel your own registration", "See the seats left"], "nonGoals": ["Paid tickets", "Registering someone else"]}, "assumptions": ["The organizer can register for their own meetup", "A full meetup refuses a registration; a waitlist is a later change"], "hints": [], "locale": "en"}, "reason": "Record the answer to Q-full."}
  ]
}
EOF
```

```bash run
git add docs/plans
git commit -m "docs: plan registrations"
bunx guren plan:approve docs/plans/registrations/plan.json
```

The approval stands, with one advisory warning about `action.meetups.show`. The plan changes what that action passes to its page, but the only property of an action Guren reads is which page it renders, and that holds already. Nothing in the code can show this change, so `plan:status` will never confirm it from properties alone. Only a verified behaviour that reaches the action can, and `AC-registrations-7` does ("The meetup page shows the seats left").

The warning is a question for you: is there such a behaviour? Here there is, so you approve. Without one, the change would stay unconfirmed until someone waived it.

The approval also recorded, in `approvals.json`, how each `alter` read at this moment (the `readings` from the chapter 3 exercise). That is how the loop tells "changed by this plan" from "was already so".

```bash run
git add docs/plans
git commit -m "docs: approve the registrations plan"
```

## Where you are

- An approved second plan that adds registrations and alters the meetup code from the first.
- A habit for `alter`: read Impact, and ask whether each consumer is covered.

## Common trip-ups

- **`plan:render` fails with "only existing is consistent there".** An `alter` action sits under a controller marked `existing`. Mark the controller `alter` too.
- **Impact is empty for an element you know is used.** The scanners follow imports and names they can resolve statically. Search the code yourself before trusting an empty list.

## Exercises

1. Remove `AC-registrations-7` from a copy of the plan, save it outside the app, and render it with `--app .` and `-o` to a file outside the app too. Which check fails, and on which element?
2. In `docs/plans/registrations/approvals.json`, read the `readings` for `view.meetups.show`. Which prop reads `differ` and which `match`, and which of the two can the loop later confirm as this plan's work?

## Next

[Chapter 7: When the Application Moves](./07-when-the-application-moves.md) builds this plan while a teammate changes the code underneath it.
