import type { Actor, SequenceDiagram, SequenceStep } from './StepSequence.js'

const REQUEST: Actor = { label: { en: 'Request', ja: 'リクエスト' } }
const QUEUE: Actor = { label: { en: 'Queue', ja: 'キュー' }, tone: 'accent' }
const WORKER: Actor = { label: { en: 'Worker', ja: 'ワーカー' }, tone: 'ok' }

const DISPATCH: SequenceStep[] = [
  {
    actor: REQUEST,
    label: 'Job.dispatch()',
    note: { en: 'the controller enqueues the job', ja: 'コントローラーがジョブを積む' },
    text: {
      en: 'The controller dispatches the job, which the driver stores on its queue. Nothing runs yet.',
      ja: 'コントローラーがジョブを dispatch すると、ドライバーがキューに保存します。この時点ではまだ何も実行されません。',
    },
    link: { anchor: { en: 'dispatching-jobs', ja: 'ジョブのディスパッチ' } },
    fallback: 'dispatch',
  },
  {
    actor: REQUEST,
    label: { en: 'Response', ja: 'レスポンス' },
    note: { en: 'sent immediately', ja: 'すぐに返る' },
    text: {
      en: 'The response goes out as soon as the job is enqueued. The request never waits for handle().',
      ja: 'ジョブをキューに積んだ時点でレスポンスを返します。リクエストが handle() の完了を待つことはありません。',
    },
    fallback: 'R[',
  },
]

const attempt = (count: number): SequenceStep => ({
  actor: WORKER,
  label: 'handle()',
  note: { en: `attempt ${count} of 3`, ja: `試行 ${count} / 3` },
  text: {
    en: `A worker, a separate process, takes the job off the queue and runs handle(). This is attempt ${count}; maxAttempts (3 by default) counts the first run too.`,
    ja: `別プロセスのワーカーがジョブをキューから取り出し、handle() を実行します。これは ${count} 回目の試行で、maxAttempts（既定は 3）は初回の実行も数えます。`,
  },
  link: { anchor: { en: 'running-workers', ja: 'ワーカーの実行' } },
  fallback: 'handle()',
})

const release = (count: number, seconds: number): SequenceStep => ({
  actor: QUEUE,
  label: `release(${seconds}s)`,
  note: { en: `attempt ${count} threw`, ja: `試行 ${count} が例外` },
  text: {
    en: `handle() threw with attempts left, so the job goes back on the queue. With the default exponential backoff, a Memory or Redis queue hands it out again after ${seconds} seconds.`,
    ja: `試行回数が残っているうちに handle() が例外を投げたので、ジョブはキューに戻ります。既定の指数バックオフでは、Memory か Redis のキューが ${seconds} 秒後にもう一度ワーカーに渡します。`,
  },
  link: { anchor: { en: 'job-configuration', ja: 'ジョブ設定' } },
  fallback: 'Retry[',
})

const SUCCESS: SequenceStep = {
  actor: QUEUE,
  label: 'delete',
  note: { en: 'removed from the queue', ja: 'キューから削除' },
  text: {
    en: 'handle() resolved, so the job is removed from the queue and is done.',
    ja: 'handle() が正常に終わったので、ジョブはキューから削除されて完了します。',
  },
  fallback: 'OK[',
}

export const QUEUE_LIFECYCLE: SequenceDiagram = {
  intro: {
    en: 'Pick how handle() behaves and follow the job from the request to the worker.',
    ja: 'handle() の結果を選ぶと、リクエストからワーカーまでのジョブの流れをたどれます。',
  },
  intervalMs: 1500,
  scenarios: [
    {
      id: 'succeeds',
      label: { en: 'Succeeds', ja: '成功する' },
      steps: [...DISPATCH, attempt(1), SUCCESS],
    },
    {
      id: 'fails-once',
      label: { en: 'Fails once', ja: '1 回失敗する' },
      steps: [...DISPATCH, attempt(1), release(1, 2), attempt(2), SUCCESS],
    },
    {
      id: 'always-fails',
      label: { en: 'Always fails', ja: '毎回失敗する' },
      steps: [
        ...DISPATCH,
        attempt(1),
        release(1, 2),
        attempt(2),
        release(2, 4),
        attempt(3),
        {
          actor: QUEUE,
          label: 'fail',
          note: { en: 'recorded as failed', ja: '失敗ジョブとして記録' },
          text: {
            en: 'The last attempt threw, so the job moves to the failed jobs store and its failed() hook, if it has one, runs. guren queue:retry puts it back on the queue.',
            ja: '最後の試行も例外を投げたので、ジョブは失敗ジョブの保存先に移り、failed() フックがあれば呼ばれます。guren queue:retry でキューに戻せます。',
          },
          link: { anchor: { en: 'failed-jobs', ja: '失敗したジョブ' } },
          fallback: 'Failed[',
        },
      ],
    },
  ],
}
