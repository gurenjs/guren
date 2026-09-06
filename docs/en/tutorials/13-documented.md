# Chapter 13: Documentation That Cannot Go Stale

Every project you have ever joined had a `README` that was wrong. Not maliciously: someone wrote it when it was true, the code moved, and nothing failed. That is the whole problem, and it has exactly two halves.

Some documents are *derived*. An entity-relationship diagram is a rendering of `db/schema.ts` and the relations on your models; nobody should be typing it. Guren generates those, and then fails the build when the committed copy stops matching the code.

The other half nobody can generate. Why comments cascade with their post, why uploads sit on a private disk, what "published" means in this app: none of that is in the code, because it is the reasoning that produced the code. You write those, and Guren checks that what they claim to be about still exists.

**What you'll learn:**

- Which documents a framework can derive, and which only you can write
- How a diagram becomes something CI can fail on
- What an entity document declares, and how it reaches an agent before it touches your model
- The one maintenance rule that keeps all of it honest

## 1. The derived half

The generators read your code, so make sure the generated code they read is current first:

```bash run
bun run codegen
```

```bash run
bunx guren spec:generate
```

Four files under `docs/spec/`, and each is a view of something you already have:

| File | Derived from |
|---|---|
| `er.md` | `db/schema.ts`: tables, columns, keys, and the foreign keys between them, plus the edges your models' relations declare |
| `domain.md` | `app/Models/`: the classes, what each one is, and the relations between them |
| `screens.md` | routes, controllers and pages: every route, the action behind it, and the page component it renders with the props it passes |
| `modules.md` | every source file's imports: which part of the app depends on which |

Open `docs/spec/er.md`. It is a mermaid diagram and a table per table, and it knows about `posts`, `users`, `comments`, `tags`, `post_tags` and `attachments` because you wrote them, not because anyone described them. Open `docs/spec/screens.md` and look for the page you built in chapter 4: its `Props` type is quoted from your own source.

Each file opens with a line telling you not to edit it, and frontmatter recording that a process generated it. Both are true, and the next section is about what happens when you ignore the first one.

```bash run
bunx guren check --spec
```

Four passes: each committed file matches what regenerating it right now would produce. Commit them, because a derived file that is not committed cannot drift and cannot be reviewed either:

```bash run
git add -A
git commit -m "docs: generate the spec views"
```

## 2. The gate

The point of committing generated files is that a diff shows up in review when the shape of the system changes. The point of *checking* them is that the diff cannot be forgotten. Pretend you edited a diagram by hand:

```bash run
printf '\nThe posts table also stores a word count.\n' >> docs/spec/er.md
```

```bash run expect-fail
bunx guren check --spec
```

```bash manual
ERROR  [fail] docs/spec/er.md: docs/spec/er.md is out of date with the code.
       → Run: bunx guren spec:generate

Results: 3 passed, 0 warnings, 1 failures
```

The check does not diff the file against a stored hash. It regenerates all four views in memory from your current code and compares bytes. So this fails for a sentence you added by hand, and it fails in exactly the same way when you add a column to `db/schema.ts` and forget to regenerate. The document cannot be wrong, because the only way to change it is to change the code.

```bash run
bunx guren spec:generate
```

```bash run
bunx guren check --spec
```

That is the maintenance rule, and it is one line: **after any structural change, regenerate and commit the result with the change.** Which views a change touches follows from what they read.

| You changed | Regenerate |
|---|---|
| `db/schema.ts` | `er.md`, `modules.md` |
| a model or its relations | `er.md`, `domain.md`, `modules.md` |
| a route, controller or page | `screens.md`, `modules.md` (run `codegen` first) |
| any source file at all | `modules.md` |

The last row makes the table academic in practice: run `bunx guren codegen && bunx guren spec:generate` and let it sort itself out. `guren gate` runs the check, so the answer to "did I forget?" is the same command you already run before every commit.

## 3. The half nobody can generate

Your `comments` table cascades from `posts`. The schema says so, the ER diagram now draws it, and neither of them says *why* it is a cascade rather than a soft delete or an orphan. That is a decision, and decisions have a home:

```bash run
bunx guren make:adr "Comments are deleted with their post" --entity Comment --by "human:you"
```

The command numbered it after the ADR your app was scaffolded with, slugged the title, and filled in the links: `entities: [Comment]` because you passed `--entity`, and `related:` with the controller, resource and policy it found for that model. What it cannot fill in is the argument. Write that:

```md file=docs/adr/0002-comments-are-deleted-with-their-post.md
---
type: adr
status: stable
entities: [Comment]
related:
  - app/Http/Controllers/CommentController.ts
  - app/Http/Resources/CommentResource.ts
  - app/Policies/CommentPolicy.ts
generated: { by: "human:you", at: 2026-09-06T00:00:00Z }
---

# Comments are deleted with their post

## Context

A comment has no meaning without the post it answers. Keeping comments after
their post is gone leaves rows nothing can render, and every query that joins
them has to remember the case.

## Decision

`comments.postId` references `posts.id` with `onDelete: 'cascade'`. Deleting a
post deletes its comments, in the database, in one statement.

## Consequences

There is no "orphaned comment" state to design for, and no cleanup job. The
cost is that a post deletion is unrecoverable: an accidental delete takes the
discussion with it, and the only defence is the policy that decides who may
delete a post.
```

An ADR is one decision, written once, and left alone. Its frontmatter is what makes it more than a file in a folder: `entities` and `related` are claims about what this decision governs, and they are checked.

```bash run
bunx guren check --docs
```

`All 4 link(s) resolve.` The four are one entity and three files. Rename `CommentPolicy.ts` without touching this ADR and the check names the ADR, not the policy: the document is what broke.

## 4. What an entity document is for

An ADR records a decision. A context document describes a thing: what a `Comment` is in this app, what is true of it, and where the rules live. That is the document an agent should read before it touches the model.

```md file=docs/context/comments.md
---
type: context
status: stable
entities: [Comment, Post]
related:
  - app/Models/Comment.ts
  - app/Http/Controllers/CommentController.ts
  - app/Policies/CommentPolicy.ts
generated: { by: "human:you", at: 2026-09-06T00:00:00Z }
---

# Comments

A comment belongs to one post and to the user who wrote it. Both are required
and both are set by the server from the route and the session, never from the
request body.

## Rules

- Anyone signed in may comment. Only the comment's own author may delete it,
  including the post's author, who has no special power over other people's
  comments. `CommentPolicy` is the only place that decides this.
- The body is trimmed and must not be empty; the message a reader sees for an
  empty comment lives in `CommentValidator`, not in the page.
- Deleting a post deletes its comments
  ([the decision](../adr/0002-comments-are-deleted-with-their-post.md)).

## Notifications

Posting a comment emits `CommentPosted`, which queues one mail to the post's
author unless the commenter *is* the post's author. The skip lives in the job,
so it applies to every future way a comment can be created.
```

Now connect it from the code side. A doc's frontmatter points at code; a `@docs` tag points back:

```ts file=app/Http/Controllers/CommentController.ts
import { Controller } from '@guren/core'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPosted } from '../../Events/CommentPosted.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'

/** @docs docs/context/comments.md */
export default class CommentController extends Controller {
  private isToolCall(): boolean {
    return this.ctx.req.header('X-Guren-Agent-Surface') !== undefined
  }

  async store(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('create', Comment)
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(CommentPayloadSchema)
    const comment = await Comment.forceCreate({ ...data, postId: post.id, authorId: author.id })
    await this.make('events').emit(new CommentPosted(comment.id))

    if (this.isToolCall()) {
      const fresh = await Comment.findWithOrFail(comment.id, 'author')
      return this.json({ comment: new CommentResource(fresh).toJSON() })
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const comment = this.model(Comment)
    await this.authorize('delete', [Comment, comment])
    await Comment.delete({ id: comment.id })

    if (this.isToolCall()) {
      return this.json({ deleted: comment.id })
    }
    return this.redirect(`/posts/${comment.postId}`)
  }
}
```

```bash run
bunx guren check --docs
```

The tag is checked like everything else: point it at a file that does not exist and the check fails naming the controller. Tags are read in `app/Models/` and `app/Http/Controllers/` only, which is the point rather than a limitation. Those are the two places someone lands when they are about to change behaviour.

Now see what all of this was for:

```bash run
bunx guren context Comment
```

Among the sections describing the model, its routes, its controller, its policy and the tools chapter 12 exposed, there is now **Linked docs**, listing both files you just wrote. That output is what the harness puts in front of an agent when it works on `Comment`, and it is why the frontmatter matters more than the prose: `entities: [Comment]` is what got the document into that list.

```bash run
bunx guren docs:graph --entity Comment
```

The graph reads the same links from the other end: documents, entities, code, and the edges between them. Nothing here is a convention you have to remember, because everything in it is either derived from the code or declared in frontmatter the check validates.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "docs: record the comment decision and its context"
```

## 5. Specify the rest

Comments are documented. Posts, the model with the most decisions behind it, are not. Make that a test rather than an intention:

```ts file=tests/Documentation.test.ts
import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'

/** Every model a reader can reach has a context doc that names it. */
const DOCUMENTED = [
  ['Comment', 'docs/context/comments.md'],
  ['Post', 'docs/context/posts.md'],
] as const

describe('documentation', () => {
  for (const [entity, path] of DOCUMENTED) {
    it(`has a context doc for ${entity}`, async () => {
      const doc = await readFile(path, 'utf8')

      expect(doc).toContain('type: context')
      expect(doc).toContain(entity)
    })
  }
})
```

```bash run expect-fail
bun test
```

Red: there is no `docs/context/posts.md`.

## 6. Delegate it

> Write `docs/context/posts.md`, a context document for the `Post` model, in the shape of `docs/context/comments.md`. Cover what a post is, who may change it, what publishing means, and how cover images and the gallery are stored and served. Also record the storage decision as an ADR with `bunx guren make:adr`, and link the two. `tests/Documentation.test.ts` and `bunx guren check --docs` both have to pass.

This is the chapter's harness lever, and it works in the direction you have not seen yet. Every other chapter put a rule in front of the agent before it wrote code. Here the agent has to *read* your app to write anything true, and the two commands it has for that are the two you just ran: `guren context Post` tells it what a post touches, and `docs:graph` tells it what is already documented. An agent that writes a plausible document without reading either will get the details wrong, and the details are checkable.

**No agent handy?** The document:

```md file=docs/context/posts.md fallback
---
type: context
status: stable
entities: [Post, User]
related:
  - app/Models/Post.ts
  - app/Http/Controllers/PostController.ts
  - app/Policies/PostPolicy.ts
  - config/attachments.ts
generated: { by: "human:you", at: 2026-09-06T00:00:00Z }
---

# Posts

A post belongs to the user who wrote it. `authorId` is not null and is set by
the server from the session; it is never in `fillable` and never comes from a
form.

## Who may change one

`PostPolicy` decides, and every mutating action calls it. The author may
update, delete and publish; nobody else may do any of those, including through
the agent tools, which run the same policy on the same request.

## Publishing

`publishedAt` is null for a draft and a timestamp once published. Publishing
emits `PostPublished`, which mails everyone who commented on the post except
the author. There is no separate "status" column: the timestamp is the state,
and it doubles as the record of when it happened.

## Files

A post has one `cover` and many `images`, both declared on the model through
`Attachable`. Uploads are stored on the `local` disk, which is rooted outside
`public/`, and reach a browser only through a signed, expiring delivery route
([the decision](../adr/0003-uploads-are-served-from-a-private-disk.md)).
Deleting a post purges its attachments first, because the attachments table is
polymorphic and nothing cascades for it.

## Tags

Tags are a many-to-many through `post_tags`, written by deleting the post's
rows and recreating them. Normalisation (trim, lower-case, de-duplicate) is in
`PostValidator`, so `store` and `update` cannot disagree about what a tag is.
```

And the decision behind the storage choice:

```md file=docs/adr/0003-uploads-are-served-from-a-private-disk.md fallback
---
type: adr
status: stable
entities: [Post]
related:
  - config/attachments.ts
  - app/Models/Post.ts
generated: { by: "human:you", at: 2026-09-06T00:00:00Z }
---

# Uploads are served from a private disk

## Context

An upload is bytes a stranger chose. Anything under `public/` is served
statically by path, so a file there is readable by anyone who can guess or
learn its URL, forever, with no check of any kind.

## Decision

Attachments are stored on the `local` disk, rooted at `./storage/app`, which
nothing serves. `config/attachments.ts` declares that disk private and enables
the delivery route, so every URL the app hands out is signed and expires.

## Consequences

An image URL cannot be shared indefinitely, and a page that renders one has to
be re-rendered to mint a fresh link. In exchange there is no way to reach an
upload except through code that decided to hand it out, and `guren check`
fails the build if the disk is ever moved under `public/`.
```

```bash run
bun test
```

```bash run
bunx guren check --docs
```

The rubric:

- `docs/context/posts.md` exists, its `type` is `context`, and its `entities` and `related` all resolve. `guren check --docs` reports every link, so a plausible-looking `related:` entry naming a file that does not exist is a failure, not a typo nobody notices.
- The claims are true of this app: `authorId` is server-set, the policy gates the mutations, `publishedAt` is the state, uploads are private and signed, tags go through the pivot. Read them against the code, because nothing checks prose.
- The ADR is a decision with consequences, not a description. If it reads like the context document, it is in the wrong file.
- The two link to each other, and both survive `bunx guren docs:graph --entity Post`.

```bash run
bunx guren docs:graph --entity Post
```

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "docs: document posts and the private-disk decision"
```

## 7. Where the work itself lives

You now have documents describing the system. What you deliberately do not have is a document describing the *work*: no `tasks.md`, no plan file, no status mirror in `docs/`. That is not an oversight. A task list committed to a repository is stale the moment anyone touches the board, and it is the second thing every project has that is always wrong.

Guren's answer is one frontmatter field. Work items live where they already live, on GitHub, and a document says which of them it belongs to:

```md manual
---
type: adr
status: stable
entities: [Post]
issues: [412, "acme/blog#398"]
---
```

`make:adr` fills it in for you when you pass `--issue`:

```bash manual
bunx guren make:adr "Drafts expire after ninety days" --entity Post --issue 412
```

`guren check --docs` validates the shape of each reference and nothing else. It never asks GitHub whether issue 412 exists, because the check is a gate and a gate that needs the network is a gate that fails on a plane. `guren context Post` lists the issues its documents declare, and `guren context Post --live` is the one command in the whole toolchain that goes to the network, reporting each issue's state and assignee before you pick up work someone else already holds.

Watch the YAML, because this one bites: `issues: [412, #398]` loses everything after the `412`, since an unquoted `#` starts a comment. Quote it, or write the bare number.

## Where you are

- Four generated views of your app, committed, and a build that fails when they stop matching the code.
- Two documents nobody could have generated, linked to the model and the files they govern, with those links checked.
- A `@docs` tag pointing from the controller back at the document, so the connection is visible from either end.
- An entity bundle (`guren context Post`) that now carries the decisions along with the code, which is what an agent reads before it changes anything.

## Common trip-ups

- **`spec:generate` printed a warning and wrote three files.** A view whose sources it could not read is skipped rather than written wrong. Run `bunx guren codegen` first: `screens.md` imports your route graph, which imports generated code.
- **`check --spec` fails right after `spec:generate`.** Something changed between the two commands, or you edited a view. These files are output; edit the code instead.
- **A doc link fails after a rename.** That is the feature. Update the `related:` entry or the `@docs` tag in the same commit as the rename; `bunx guren docs:graph --path <file>` tells you what governs a file before you move it.
- **`check --docs` warns that a doc has no frontmatter.** Any markdown under `docs/` that is not a concept document should say so with at least a `type:`; `index.md` and `log.md` are the two exempt names.
- **`guren check` printed failures and exited 0.** Plain `check` reports; `check --docs`, `check --spec` and `guren gate` are what set an exit code. The gate is stricter still: it fails on warnings too.
- **Do not set `stale_after:` in a document you are not going to revisit.** It warns from that date onward, and a warning fails the gate.

## Next

[Chapter 14: Production](./14-production.md) is the last one: sessions that survive a restart, rate limiting, what `NODE_ENV=production` changes for you, and an honest list of what this app still is not ready for.
