import type { InteractiveDiagramProps } from './registry.js'

type Locale = InteractiveDiagramProps['locale']

export type StepKind = 'name' | 'function' | 'router'

export interface MiddlewareStep {
  id: string
  kind: StepKind
  code: string
  where: Record<Locale, string>
  text: Record<Locale, string>
}

/** The middleware guide's "Execution Order" example, one entry per box in its flowchart. */
export const MIDDLEWARE_STEPS: Record<string, MiddlewareStep> = {
  inlineA: {
    id: 'inlineA',
    kind: 'function',
    code: '.middleware(inlineA)',
    where: { en: 'outer group', ja: '外側グループ' },
    text: {
      en: "An inline function on the outer group. Functions run after every name in the chain, so it runs after 'auth' even though it is written first.",
      ja: "外側グループに書いたインラインの関数です。関数はチェーンにあるすべての名前より後に動くので、先に書いてあっても 'auth' の後に実行されます。",
    },
  },
  auth: {
    id: 'auth',
    kind: 'name',
    code: ".middleware('auth')",
    where: { en: 'inner group', ja: '内側グループ' },
    text: {
      en: 'An alias name on the inner group. Every alias or group name in the chain runs first, outer groups first.',
      ja: '内側グループに付けたエイリアスの名前です。チェーンにある名前はすべて最初に、外側のグループから順に実行されます。',
    },
  },
  inlineB: {
    id: 'inlineB',
    kind: 'function',
    code: '.middleware(inlineB)',
    where: { en: 'route', ja: 'ルート' },
    text: {
      en: "The route's own inline function. Among functions, outer groups come first, so it follows inlineA.",
      ja: 'ルート自身のインラインの関数です。関数どうしでは外側のグループが先なので、inlineA の次に実行されます。',
    },
  },
  validation: {
    id: 'validation',
    kind: 'router',
    code: 'body / params / query',
    where: { en: 'route contract validation', ja: 'ルートコントラクトの検証' },
    text: {
      en: 'The schemas attached to the route are validated after all middleware. This step cannot be moved.',
      ja: 'ルートに付けたスキーマは、すべてのミドルウェアが終わったあとに検証されます。この段は並べ替えられません。',
    },
  },
  action: {
    id: 'action',
    kind: 'router',
    code: 'controller action',
    where: { en: 'the handler', ja: 'ハンドラー' },
    text: {
      en: 'The controller action runs last, immediately after validation.',
      ja: '最後に、検証の直後にコントローラーのアクションが実行されます。',
    },
  },
}

export type Order = 'written' | 'run'

export const ORDERS: Record<Order, string[]> = {
  written: ['inlineA', 'auth', 'inlineB', 'validation', 'action'],
  run: ['auth', 'inlineA', 'inlineB', 'validation', 'action'],
}

export const PLAY_INTERVAL_MS = 1100

export const LABELS = {
  en: {
    intro: 'Switch between the order the code reads and the order a request runs through.',
    orderGroup: 'Order',
    order: { written: 'As written', run: 'As it runs' },
    play: 'Send a request',
    pause: 'Pause',
    replay: 'Send again',
    kind: { name: 'name', function: 'function', router: 'router' },
    added: 'added by the router',
  },
  ja: {
    intro: 'コードを書いた順と、リクエストが通る順を切り替えて見比べられます。',
    orderGroup: '並び順',
    order: { written: '書いた順', run: '実際に走る順' },
    play: 'リクエストを送る',
    pause: '一時停止',
    replay: 'もう一度送る',
    kind: { name: '名前', function: '関数', router: 'ルーター' },
    added: 'ルーターが追加',
  },
} satisfies Record<Locale, unknown>
