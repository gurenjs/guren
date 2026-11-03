import { docPaths } from '../../../../config/site.js'
import type { Actor, SequenceDiagram, SequenceStep } from './StepSequence.js'

const YOU: Actor = { label: { en: 'You', ja: '読者' }, tone: 'accent' }
const AGENT: Actor = { label: { en: 'Agent', ja: 'エージェント' }, tone: 'ok' }
const chapter = (slug: string) => ({
  href: docPaths('agent-course', slug),
  label: { en: 'Read the chapter', ja: 'この章を読む' },
})

const ASK: SequenceStep = {
  actor: YOU,
  label: { en: '1. Ask', ja: '1. 依頼' },
  note: { en: 'a request, then answers', ja: '依頼して質問に答える' },
  text: {
    en: 'You describe what to build. The agent writes a plan from it and asks the questions it cannot settle alone, and you answer them.',
    ja: '作りたいものを依頼します。エージェントはそれをもとに計画を書き、自分では決められない点を質問してくるので、それに答えます。',
  },
  link: chapter('02-the-first-plan'),
  fallback: 'Ask[',
}

const REVIEW: SequenceStep = {
  actor: YOU,
  label: { en: '2. Review', ja: '2. レビュー' },
  note: { en: 'the plan page', ja: '計画のレビューページ' },
  text: {
    en: 'You read the plan page before any code exists and judge whether it describes what you want.',
    ja: 'コードがまだ 1 行もないうちに計画のページを読み、作りたいものが書かれているかを判断します。',
  },
  link: chapter('03-review-and-approve'),
  fallback: 'Review[',
}

const LATER: SequenceStep[] = [
  {
    actor: YOU,
    label: { en: '3. Approve', ja: '3. 承認' },
    note: { en: 'you, never the agent', ja: '読者だけが行う' },
    text: {
      en: 'Approving fixes the design. You run plan:approve yourself; the agent never approves its own plan.',
      ja: '承認した時点で設計が決まります。plan:approve は読者が自分で実行し、エージェントが自分の計画を承認することはありません。',
    },
    link: chapter('03-review-and-approve'),
    fallback: 'Approve[',
  },
  {
    actor: AGENT,
    label: { en: '4. Build', ja: '4. 実装' },
    note: { en: 'one verified step per commit', ja: '検証済みのステップを 1 コミットずつ' },
    text: {
      en: 'The agent implements one step at a time and commits it. Guren reads from the code and the tests whether the step is done, and you accept each commit.',
      ja: 'エージェントはステップを 1 つずつ実装してコミットします。ステップが終わったかどうかは Guren がコードとテストから読み取り、読者は届いたコミットを 1 つずつ受け入れます。',
    },
    link: chapter('04-one-step-at-a-time'),
    fallback: 'Build[',
  },
  {
    actor: YOU,
    label: { en: '5. Close', ja: '5. クローズ' },
    note: { en: 'docs written from the plan', ja: '計画からドキュメントを書く' },
    text: {
      en: 'Once every step is verified, plan:close writes what the plan decided into the docs.',
      ja: 'すべてのステップの検証が通ったら、plan:close で計画の決定事項をドキュメントに書き残します。',
    },
    link: chapter('05-close-the-plan'),
    fallback: 'Close[',
  },
]

export const COURSE_LOOP: SequenceDiagram = {
  intro: {
    en: 'Select a stage to see who acts and which chapter covers it, or play a plan through the loop.',
    ja: '段階を押すと、誰が動くかと、その段階を扱う章が表示されます。流れに沿って計画を再生することもできます。',
  },
  intervalMs: 1600,
  scenarios: [
    {
      id: 'approved',
      label: { en: 'Approved as written', ja: 'そのまま承認' },
      steps: [ASK, REVIEW, ...LATER],
    },
    {
      id: 'changes',
      label: { en: 'Changes requested', ja: '修正を依頼' },
      steps: [
        ASK,
        REVIEW,
        {
          actor: AGENT,
          label: 'plan:revise',
          note: { en: 'from your saved review', ja: '保存したレビューから' },
          text: {
            en: 'Your review asked for changes, so the agent revises the plan from it with plan:revise, which records each change with its reason. Nothing is approved yet.',
            ja: 'レビューで修正を求めたので、エージェントがそれをもとに plan:revise で計画を書き直します。変更はそれぞれ理由と一緒に記録され、まだ何も承認されていません。',
          },
          link: chapter('03-review-and-approve'),
          fallback: 'Review -.',
        },
        REVIEW,
        ...LATER,
      ],
    },
  ],
}
