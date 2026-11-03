import type { Actor, SequenceDiagram, SequenceStep } from './StepSequence.js'

const BROWSER: Actor = { label: { en: 'Browser', ja: 'ブラウザー' } }
const MIDDLEWARE: Actor = { label: { en: 'CSRF middleware', ja: 'CSRF ミドルウェア' }, tone: 'accent' }
const CONTROLLER: Actor = { label: { en: 'Controller', ja: 'コントローラー' }, tone: 'ok' }

const RENDER_FORM: SequenceStep[] = [
  {
    actor: BROWSER,
    label: 'GET /form',
    note: { en: 'safe method, not verified', ja: '安全なメソッドなので検証なし' },
    text: {
      en: 'The browser asks for the page with the form. GET is a safe method, so the middleware checks nothing on it.',
      ja: 'ブラウザーがフォームのあるページを要求します。GET は安全なメソッドなので、ミドルウェアはここでは何も検証しません。',
    },
    fallback: 'GET /form',
  },
  {
    actor: MIDDLEWARE,
    label: { en: 'Issue the token', ja: 'トークンを発行' },
    note: { en: 'a double-submit token for guests', ja: 'ゲストは double-submit トークン' },
    text: {
      en: "The middleware issues a token bound to the session. A guest without a session gets a stateless double-submit token instead.",
      ja: 'ミドルウェアがセッションに結び付いたトークンを発行します。セッションのないゲストには、状態を持たない double-submit トークンを発行します。',
    },
    fallback: 'double-submit',
  },
  {
    actor: CONTROLLER,
    label: '_token / XSRF-TOKEN',
    note: { en: 'a hidden field and a cookie', ja: 'hidden のフィールドとクッキー' },
    text: {
      en: 'The page carries the token twice: a hidden _token field for a native form, and an XSRF-TOKEN cookie that Inertia sends back as a header.',
      ja: 'ページにはトークンが 2 か所に入ります。ネイティブのフォーム向けの hidden の _token と、Inertia がヘッダーとして送り返す XSRF-TOKEN クッキーです。',
    },
    link: { anchor: { en: 'including-the-token-in-forms', ja: 'フォームにトークンを含める' } },
    fallback: 'XSRF-TOKEN',
  },
]

export const CSRF_EXCHANGE: SequenceDiagram = {
  intro: {
    en: 'Follow the token from the GET that renders a form to the POST that submits it, or from a form on another site.',
    ja: 'フォームを表示する GET から送信する POST までのトークンの流れと、別サイトのフォームから送られた場合の流れを切り替えて見られます。',
  },
  intervalMs: 1500,
  scenarios: [
    {
      id: 'own-form',
      label: { en: 'Your form', ja: '自分のフォーム' },
      steps: [
        ...RENDER_FORM,
        {
          actor: BROWSER,
          label: 'POST /form',
          note: { en: 'with _token or X-XSRF-TOKEN', ja: '_token または X-XSRF-TOKEN 付き' },
          text: {
            en: 'The form submits with the token it was given, in the _token field or the X-XSRF-TOKEN header.',
            ja: 'フォームは受け取ったトークンを付けて送信されます。_token フィールドか X-XSRF-TOKEN ヘッダーのどちらかです。',
          },
          fallback: 'POST /form',
        },
        {
          actor: MIDDLEWARE,
          label: { en: 'Match the token', ja: 'トークンを照合' },
          note: { en: 'against the session value', ja: 'セッションの値と照合' },
          text: {
            en: 'POST, PUT, PATCH and DELETE are verified: the submitted token has to match the one the middleware issued.',
            ja: 'POST、PUT、PATCH、DELETE は検証の対象です。送られてきたトークンは、ミドルウェアが発行したものと一致する必要があります。',
          },
          fallback: 'X-XSRF-TOKEN',
        },
        {
          actor: CONTROLLER,
          label: '200',
          note: { en: 'the action runs', ja: 'アクションを実行' },
          text: {
            en: 'The tokens match, so the request reaches the controller action.',
            ja: 'トークンが一致したので、リクエストはコントローラーのアクションまで届きます。',
          },
          fallback: '200',
        },
      ],
    },
    {
      id: 'other-site',
      label: { en: 'A form on another site', ja: '別サイトのフォーム' },
      steps: [
        ...RENDER_FORM,
        {
          actor: { label: { en: 'Another site', ja: '別サイト' } },
          label: 'POST /form',
          note: { en: 'it cannot read the token', ja: 'トークンを読めない' },
          text: {
            en: 'A page on another site can make the browser submit to your app, but it cannot read the token your page carries, so the POST arrives without a matching one.',
            ja: '別サイトのページでも、ブラウザーにアプリへの送信をさせることはできます。ただしページにあるトークンは読めないので、POST には一致するトークンが付いていません。',
          },
          fallback: 'POST /form',
        },
        {
          actor: MIDDLEWARE,
          label: '403 / 419',
          note: { en: 'missing or mismatched', ja: '欠落または不一致' },
          text: {
            en: 'The middleware rejects the request before any controller runs: 403 JSON, or a 419 page for a browser navigation.',
            ja: 'ミドルウェアは、コントローラーが動く前にリクエストを拒否します。返すのは 403 の JSON で、ブラウザーの遷移には 419 のページです。',
          },
          link: { anchor: { en: 'configuration-options', ja: '設定オプション' } },
          fallback: '403',
        },
      ],
    },
  ],
}
