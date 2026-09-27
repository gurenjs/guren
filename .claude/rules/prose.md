# Prose

Applies to every sentence of documentation written or generated in this repo:
docs/en, docs/ja, and Japanese or English prose elsewhere (web/ strings, PR
bodies, issues). The reader is an engineer; the text must read as if a person
wrote it in that language from the start, not as machine output and not as a
translation. The mechanical half is `bun run audit:prose` (CI, and the edit
hook on any docs/en or docs/ja file); the judgment half is below.

## What actually marks prose as machine-written

Measured, not folklore (sources: Wikipedia "Signs of AI writing", the 2025
Science Advances excess-vocabulary study, textlint-rule-preset-ai-writing):

- **Density, not presence.** A single em-dash, "robust", or 「これにより」 proves
  nothing; humans use all three. What reads as machine output is the rate:
  em-dashes at 9-10 per 1000 words against 3-6 in human technical prose, the
  same filler verb in every opening sentence, every list item bolded.
- **Shape more than words.** Emoji headings, bold inside headings, `**Word**:`
  on every bullet, a closing "In conclusion" paragraph, the preview → body →
  「以上のように」 three-act structure in Japanese. Word lists rot as models
  change (GPT-5.1 was told to stop using em-dashes); shape tells do not.
- **Negative parallelism and tricolons** ("not just X, but Y", "It's not X —
  it's Y", three-item everything) are the strongest sentence-level tell, but
  they are also legitimate rhetoric, so they are reviewed, never linted.

## English (docs/en)

Linted:
- Em-dash density above 5 per 1000 prose words (floor of 2 per file). Rewrite
  with a comma, a colon, parentheses, or a new sentence. Dashes in headings,
  tables and code are not counted.
- Vocabulary: delve, tapestry, leverage, seamless, robust, comprehensive,
  crucial, pivotal, underscores, showcase, testament, realm, intricate,
  vibrant, game-changer, paradigm shift, streamline, elevate, empower, unlock.
  ("harness" is a product term and is allowed.)
- Stock phrases: in conclusion / in summary / to summarize, great question, I
  hope this helps, it's worth noting, whether you're, let's dive in, let's
  explore, in today's, in the world of, at its core, when it comes to, plays a
  crucial role, a wide range of, stands as a testament.
- Shape: no emoji or bold in headings, no emoji list markers.

Judgment:
- Open with what the thing does, not with "Guren provides a robust X system".
- One "not X but Y" per section at most; prefer stating Y.
- Lists of exactly three where the content has two or five items.
- No closing summary paragraph that restates the section.
- Bold marks the term a reader scans for, not emphasis.

## Japanese (docs/ja)

Linted: dashes (`—`, `–`) in prose; ことができます / することが可能 / を提供します /
これにより / 様子を見 / を目にし / であることを意味 / 起こりえません / にすぎません /
言い換えれば / 要するに / ことに留意 / 興味深いことに / 面白いのは / 堅牢 / シームレス /
パワフル / エレガント / 直感的 / 革命的 / ゲームチェンジャー / 私たち / あなたは /
あなたに / いかがでしたか / と言えるでしょう / 探っていきましょう; the shape rules above.
Also linted since #1110/#1112: English status words and jargon left in running
prose (verified, drifted, stalled, waiver, advisory, finding, verdict, rubric,
brief, subagent, baseline, fail-closed, read-only; judged per paragraph, and a
gloss in parentheses, a 「quoted」 output, bold, link text, a tag and inline
code are exempt); test results in colours (緑です / 赤になる); 自分の役目 /
自分のターミナル; the headings いまいる場所 and 「〜、手で」. In both locales, a
blockquote in a tutorial or agent-course chapter that is not a GitHub alert.
Chopped sentences are judgment only: no length rule tells 「テストは失敗します。
このテストが仕様です。」 from a translated chain.

Judgment (the translated-English tells rewrite #767 removed):
- **Reorder "not X but Y".** 「〜であって、〜ではありません」「〜するものではなく〜です」
  read as translation. Say the positive fact first, then the exclusion if it
  still matters.
- **No English narration.** 「〜する様子を見ます」「〜の話です」「それが教訓です」 are
  you'll-see / that's-the-lesson lifted from English. State the fact.
- **Learning-objective lists are noun phrases,** not what/why questions:
  「`forceCreate` の用途と、`authorId` を fillable にしない理由」, never
  「`forceCreate` は何のためにあるか、なぜ〜か」.
- **Drop the pronoun subject.** 「あなたの」「あなたが」 almost always go; 「あの〜」
  「この〜」 as demonstratives from *that/this* likewise.
- **Soften emphasis carried over from English.** 「決して〜してはならない」 →
  「〜しない」「〜は避けてください」.
- **One fact per sentence, 60–80 字.** Split a sentence that chains clauses with
  読点; an enumeration inside a sentence may run longer.
- **Keep the register (です・ます),** keep terms in English where the docs already
  do (Inertia, Resource, Policy, registrar, fillable), and match the file's
  majority on 全角/半角 括弧 and spaces around Latin text.

Judgment (the tells rewrites #1110 and #1112 removed; read
`docs/ja/agent-course/01-setup.md` as the reference voice):
- **Rebuild the sentence, not the words.** A Japanese sentence that stops where
  the English one stopped reads as a translation even with every word right.
  Join short sentences with 〜ので / 〜が / 〜て when they are one thought.
- **No inanimate subjects acting.** 「この節は〜を示します」「`plan:verify` は〜を
  生む」 → 「この節では〜を見ていきます」「`plan:verify` を実行すると〜が記録されます」.
- **No cleft sentences.** 「〜のは〜です」「〜するのは〜だけです」「〜のおかげです」
  → a plain statement.
- **Printed values stay printed.** A value the CLI or the page shows (`verified`,
  `advisory`, **Needs attention**) keeps its spelling in backticks or bold, with
  a Japanese gloss on first use; the running prose says it in Japanese
  (検証が通る, 参考扱いの警告).
- **One vocabulary.** verified 検証済み, drifted 検証後に変更された, stalled 行き詰まり,
  held 保留, waived 免除, advisory 参考扱い, finding 指摘, verdict 判定, baseline 基準点,
  rubric 確認項目, brief 指示書. Claude Code's own terms follow its Japanese docs:
  スキル, サブエージェント, ルール, and hooks stays hooks.
- **A prompt says where it goes.** In a course chapter the line before a prompt
  fence names the target: 「Claude Code のセッションに、次のプロンプトを送ります。」
  (agent course) or 「エージェントに次のプロンプトを送ります。」 (tutorial).

Examples:
- 悪: マニフェストは純粋なデータです — CLI はプラグインのコードを一切実行しません。
  良: マニフェストはただのデータです。CLI はインストール中にプラグインのコードを実行しません。
- 悪: `userOrFail()` が証明するのは*誰が*呼んでいるかであり、実行してよいかを決めるものではありません。
  良: `userOrFail()` は呼び出し元が誰かを確かめるだけで、実行する権限があるかまでは判断しません。
- 悪: ステップは Guren が計画から導きます。誰も書きません。自分の役目は、各コミットを読むことです。
  良: ステップは Guren が計画から組み立てるので、人が書く必要はありません。読者は、届いたコミットを順に読んでいきます。
- 悪: 計画の実装中は、エージェントが取り組んでいるステップも検証し、verified でない間は最大 3 回までエージェントを差し戻します。
  良: 計画を実装している間は、取り組んでいるステップの検証も行い、検証が通るまで最大 3 回エージェントに差し戻します。
- 悪: Guren provides a robust queue system for deferring time-consuming tasks.
  良: The queue defers slow work (mail, imports, webhooks) to a worker process.

## Both

- Never touch code to fix prose. Code blocks, link targets, inline code and
  heading text are content, not wording; `audit:tutorial-blocks` byte-locks
  tutorial code across locales, and other guides link to headings by anchor.
- The audit is a floor, not a definition of good prose. A file can pass it and
  still read as a translation; the rules above are what the reviewer checks.
