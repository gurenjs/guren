---
name: docs-writing
description: Write or revise Guren's documentation under docs/en and docs/ja (guides, tutorial, agent course) so it reads as written by a person in that language, not as machine output or a translation. Use when adding or editing a page, translating between docs/en and docs/ja, rewriting Japanese that reads as translated, or adding a chapter, exercise or prompt to a course. Also use before splitting a large docs rewrite across subagents.
---

# Docs Writing

The rules live in `.claude/rules/prose.md`. This skill is the order to apply them in. The reference voice for Japanese is `docs/ja/agent-course/01-setup.md`; for English, `docs/en/agent-course/01-setup.md`.

## 1. Before writing

- Read `.claude/rules/prose.md` and `docs/CLAUDE.md` in full. The latter covers audience and cross-linking for every page, and the tutorial and agent-course conventions.
- Editing one locale: read the same page in the other locale for meaning. The English page is the source for facts. Neither locale gains a fact the other lacks unless you add it to both.
- Find what is load-bearing and must not change:
  - `grep -n "<file name>" scripts/smoke/docs-audit.ts`: strings the audit asserts literally.
  - Headings: other pages and `web/tests` link to them by anchor. Change one only together with every `](#…)` and `](./page.md#…)` that points at it.
  - Code fences: in the tutorial and the agent course, `bash run`, `file=` and `manual` blocks are byte-compared with the English chapter by `audit:tutorial-blocks`.

## 2. Writing Japanese

- Write the sentence the way a Japanese engineer would say the fact. Do not follow the English sentence breaks, and do not map a word to a word.
- Go through the judgment list in `prose.md` (Japanese). The ones most often missed:
  - Chopped sentences.
  - Inanimate subjects.
  - Cleft sentences (「〜のは〜です」).
  - A literal "you" (「自分の〜」).
  - English left in running prose.
- A value the CLI or the page prints stays as printed, in backticks or bold, with a Japanese gloss on first use. Use the vocabulary list in `prose.md` for everything else.
- です・ます throughout. 60–80 字 per sentence; an enumeration may run longer or become a list.

## 3. Course chapters

- A prompt for the reader to send goes in a plain ` ```text ` fence, never a blockquote.
  - The line before it names where to send it: 「Claude Code のセッションに、次のプロンプトを送ります。」 in the agent course, 「エージェントに次のプロンプトを送ります。」 in the tutorial.
  - Prompts in `docs/ja/tutorials` stay in English, the language the chapter's code uses.
- Chapter-end headings: ## ここまでの状態 / ## よくあるつまずき / ## 演習 / ## 次へ (English: Where you are / Common trip-ups / Exercises / Next).
- An exercise is followed by its own `<details>` hint and example answer.
  - Check the answer against the framework source.
  - Cite only files the reader's app has.
  - No fence in it takes an attribute.

## 4. Checking

Run all three after editing. Tests are CI's.

```bash
bun run audit:prose
bun run audit:docs
bun run audit:tutorial-blocks
```

`audit:prose` also runs from the edit hook on every docs file. It catches the mechanical tells, not the judgment ones. Before finishing, reread each changed paragraph against the judgment list and against the reference chapter.

## 5. Large rewrites split across subagents

1. **Before starting any agent**
   - Write the vocabulary and the file assignment into one note every agent reads.
   - Rewrite one chapter yourself as the sample, and have the person approve its voice before the rest.
2. **Worktrees.** Give all agents one worktree and disjoint files. Switching this session's worktree while they run moves every agent's write access with it. To end up with two branches, split the diff by path afterwards.
3. **After they finish.** Review the headings and the vocabulary across all files in one pass. Agents working in parallel drift apart on both.
