import type { InteractiveDiagramProps } from './registry.js'

export type Actor = 'person' | 'agent' | 'either' | 'guren'

export interface Stage {
  id: string
  command: string
  actor: Actor
  /** Heading ids the server slugger gives this stage's section of the guide. */
  anchor: Record<InteractiveDiagramProps['locale'], string>
  text: Record<InteractiveDiagramProps['locale'], string>
  writes: string
}

export const PLAN_LIFECYCLE_STAGES: Stage[] = [
  {
    id: 'write',
    command: 'plan.json',
    actor: 'either',
    anchor: { en: 'writing-a-plan', ja: '計画を書く' },
    text: {
      en: 'The design of the change, written as JSON before any code: the tables, routes and pages it adds or changes, and the behaviour each route must show.',
      ja: 'コードを書く前に、変更の設計を JSON で書きます。足したり変えたりするテーブル、ルート、ページと、ルートごとの受け入れ振る舞いを並べます。',
    },
    writes: 'docs/plans/<slug>/plan.json',
  },
  {
    id: 'render',
    command: 'plan:render',
    actor: 'guren',
    anchor: { en: 'rendering-and-checking-planrender', ja: '描画と検査-planrender' },
    text: {
      en: 'Checks the plan against the application and writes a page a person can review. A failing check does not stop the render, only the approval.',
      ja: '計画をアプリケーションと突き合わせて検査し、レビュー用のページを書き出します。検査が失敗しても描画は続きますが、そのままでは承認できません。',
    },
    writes: 'docs/plans/<slug>/plan.html',
  },
  {
    id: 'approve',
    command: 'plan:approve',
    actor: 'person',
    anchor: { en: 'approving-planapprove', ja: '承認-planapprove' },
    text: {
      en: 'The person who read the page approves the plan, which stamps it with a baseline. A failing check or an open question refuses it.',
      ja: 'ページを読んだ人が承認すると、計画に基準点が刻まれます。検査の失敗や未回答の質問が残っていると、承認は拒否されます。',
    },
    writes: 'docs/plans/<slug>/approvals.json',
  },
  {
    id: 'next',
    command: 'plan:next',
    actor: 'agent',
    anchor: { en: 'implementing-plannext-and-planverify', ja: '実装-plannext-と-planverify' },
    text: {
      en: 'Hands the agent one step, never the whole plan. The agent implements that step and commits it.',
      ja: 'エージェントに次のステップを 1 つだけ渡します。エージェントはそのステップを実装して、コミットします。',
    },
    writes: '.guren/plans/<slug>.state.json',
  },
  {
    id: 'verify',
    command: 'plan:verify',
    actor: 'guren',
    anchor: { en: 'implementing-plannext-and-planverify', ja: '実装-plannext-と-planverify' },
    text: {
      en: "Runs the step's verify commands and tests and records the outcome. The loop goes back to plan:next until every step is verified.",
      ja: 'ステップの検証コマンドとテストを実行して、結果を記録します。すべてのステップの検証が通るまで、plan:next に戻って繰り返します。',
    },
    writes: '.guren/plans/<slug>.state.json',
  },
  {
    id: 'close',
    command: 'plan:close',
    actor: 'person',
    anchor: { en: 'closing-planclose', ja: '閉じる-planclose' },
    text: {
      en: 'Once every element is verified or waived, writes what the plan decided into docs/plans/ and the entity documents.',
      ja: 'すべての要素が検証済みか免除になったら、計画で決めたことを docs/plans/ とエンティティのドキュメントに書き残します。',
    },
    writes: 'docs/plans/<slug>.md, docs/entities/<Entity>.md',
  },
]

export const LOOP_STEPS = 3

/** The order the play button walks: the next/verify pair once per step. */
export const SEQUENCE: Array<{ stage: number; step?: number }> = [
  { stage: 0 },
  { stage: 1 },
  { stage: 2 },
  ...Array.from({ length: LOOP_STEPS }, (_, index) => [
    { stage: 3, step: index + 1 },
    { stage: 4, step: index + 1 },
  ]).flat(),
  { stage: 5 },
]

export const PLAY_INTERVAL_MS = 1600

export const LABELS = {
  en: {
    intro: 'Select a stage to see who carries it out and what it writes, or play the whole flow.',
    play: 'Play the flow',
    pause: 'Pause',
    replay: 'Play again',
    loop: `Repeats for each step`,
    step: (step: number) => `Step ${step} of ${LOOP_STEPS}`,
    writes: 'Writes',
    read: 'Read the section',
    actor: { person: 'A person', agent: 'The agent', either: 'A person or the agent', guren: 'Guren' },
  },
  ja: {
    intro: '段階を押すと、その段階を担う人やツールと、書き込まれるファイルが表示されます。流れ全体を再生することもできます。',
    play: '流れを再生',
    pause: '一時停止',
    replay: 'もう一度再生',
    loop: 'ステップごとに繰り返す',
    step: (step: number) => `ステップ ${step} / ${LOOP_STEPS}`,
    writes: '書き込み先',
    read: 'この節を読む',
    actor: { person: '人', agent: 'エージェント', either: '人かエージェント', guren: 'Guren' },
  },
} as const
