/**
 * The board canvas's own words, in the language the board's notes are written in (its
 * `locale`), else English. Board text is never looked up here. The `ja` table is typed by the
 * `en` keys, so a key one locale lacks does not compile.
 */

import type { BoardNoteKind } from '../board/geometry'

const en = {
  'kind.actor': 'Actor',
  'kind.view': 'View',
  'kind.command': 'Command',
  'kind.aggregate': 'Aggregate',
  'kind.event': 'Event',
  'kind.reaction': 'Reaction',
  'kind.external': 'External',
  'kind.question': 'Question',
  'tool.add': 'Add a note',
  'tool.section': 'Section',
  'tool.connect': 'Connect',
  'tool.async': 'Async',
  'tool.sync': 'Sync',
  'tool.delete': 'Delete',
  'tool.undo': 'Undo',
  'tool.fit': 'Fit',
  'tool.zoomIn': 'Zoom in',
  'tool.zoomOut': 'Zoom out',
  'status.saving': 'Saving…',
  'status.saved': 'Saved',
  'status.dropped': '{count} edits could not apply: {reason}',
  'status.locked': 'Another writer has the board. It was read again.',
  'status.failed': 'Not saved: {reason}. The board was read again.',
  'status.connect': 'Pick the note the arrow goes to. Esc cancels.',
  'status.full': 'A board holds at most {max} notes.',
  'status.nothingToUndo': 'Nothing to undo.',
  'status.reread': 'Read again.',
  'state.present': 'In the app',
  'state.planned': 'Planned',
  'state.missing': 'Missing',
  'state.unknown': 'Unknown',
  'state.plannedIn': 'Added by {plans}',
  'links.checking': 'Checking the links against the application…',
  'links.unavailable': 'Links not checked: {reason}',
  'links.none': 'No note is linked to an element yet.',
  'links.counts': 'Links: {counts}.',
  'links.present': '{count} in the app',
  'links.planned': '{count} planned',
  'links.missing': '{count} missing',
  'links.unknown': '{count} unknown',
  'links.nowhere': 'Notes that lead nowhere: {count}.',
  'links.plans': 'Plans read: {plans}.',
  'links.noPlans': 'No open plan was read.',
  'links.unread': 'Not read: {files}.',
  'links.join': ' ',
  'input.note': 'Text of the {kind} note',
  'input.section': 'Section title',
  'input.empty': 'Write something first.',
  'input.tooLong': 'At most {max} characters.',
  'input.oneLine': 'One line, with no control characters.',
  'aria.canvas': 'Board canvas. Tab moves between notes; arrow keys move the selected notes; Enter edits; Delete removes; C starts an arrow.',
  'aria.note': '{kind}: {text}',
  'aria.noteState': '{kind}: {text}. {state}',
  'aria.section': 'Section: {title}',
  'aria.resize': 'Resize section {title}',
  'help': 'Drag notes to arrange them. Drag the background to pan, and Ctrl or ⌘ with the wheel to zoom. Double-click a note or a section title to edit it. Drop a question on a note to make it about that note.',
  'outline': 'Outline',
} as const

export type BoardWord = keyof typeof en

const ja: Record<BoardWord, string> = {
  'kind.actor': 'アクター',
  'kind.view': '画面',
  'kind.command': 'コマンド',
  'kind.aggregate': '集約',
  'kind.event': 'イベント',
  'kind.reaction': 'リアクション',
  'kind.external': '外部',
  'kind.question': '問い',
  'tool.add': '付箋を追加',
  'tool.section': '囲み',
  'tool.connect': 'つなぐ',
  'tool.async': '非同期',
  'tool.sync': '同期',
  'tool.delete': '削除',
  'tool.undo': '取り消し',
  'tool.fit': '全体を表示',
  'tool.zoomIn': '拡大',
  'tool.zoomOut': '縮小',
  'status.saving': '保存中…',
  'status.saved': '保存しました',
  'status.dropped': '{count} 件の編集は適用できませんでした: {reason}',
  'status.locked': '別の書き込みが進んでいたため、ボードを読み直しました。',
  'status.failed': '保存できませんでした（{reason}）。ボードを読み直しました。',
  'status.connect': '矢印の行き先の付箋を選んでください。Esc で取りやめます。',
  'status.full': 'ボードに置ける付箋は {max} 枚までです。',
  'status.nothingToUndo': '取り消せる操作はありません。',
  'status.reread': '読み直しました。',
  'state.present': '実装済み',
  'state.planned': '計画中',
  'state.missing': '見つからない',
  'state.unknown': '判定できない',
  'state.plannedIn': '{plans} が追加します',
  'links.checking': 'リンク先をアプリと照らし合わせています…',
  'links.unavailable': 'リンク先を確かめられませんでした: {reason}',
  'links.none': '要素にリンクした付箋はまだありません。',
  'links.counts': 'リンク: {counts}。',
  'links.present': '実装済み {count}',
  'links.planned': '計画中 {count}',
  'links.missing': '見つからない {count}',
  'links.unknown': '判定できない {count}',
  'links.nowhere': '行き先のない付箋: {count} 枚。',
  'links.plans': '読んだ計画: {plans}。',
  'links.noPlans': '開いている計画はありません。',
  'links.unread': '読めなかったもの: {files}。',
  'links.join': '',
  'input.note': '{kind}の付箋の文言',
  'input.section': '囲みの名前',
  'input.empty': '文言を入れてください。',
  'input.tooLong': '{max} 文字以内にしてください。',
  'input.oneLine': '改行と制御文字は使えません。',
  'aria.canvas': 'ボードのキャンバス。Tab で付箋を移り、矢印キーで選んだ付箋を動かし、Enter で編集、Delete で削除、C で矢印を引きます。',
  'aria.note': '{kind}: {text}',
  'aria.noteState': '{kind}: {text}。{state}',
  'aria.section': '囲み: {title}',
  'aria.resize': '囲み {title} の大きさを変える',
  'help': '付箋はドラッグで並べ替えます。背景をドラッグすると全体が動き、Ctrl か ⌘ を押しながらホイールを回すと拡大・縮小します。付箋か囲みの名前をダブルクリックすると編集できます。問いの付箋を別の付箋に重ねると、その付箋についての問いになります。',
  'outline': 'アウトライン',
}

export const BOARD_WORDS = { en, ja } as const satisfies Record<string, Record<BoardWord, string>>

export type BoardWords = (key: BoardWord, values?: Record<string, string | number>) => string

/** The table for a board's `locale`: `ja` and `ja-JP` read Japanese, anything else English. */
export function boardWords(locale: string | undefined): BoardWords {
  const table: Record<BoardWord, string> = locale?.toLowerCase().split('-')[0] === 'ja' ? BOARD_WORDS.ja : BOARD_WORDS.en
  return (key, values = {}) => table[key].replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
}

export function kindWord(words: BoardWords, kind: BoardNoteKind): string {
  return words(`kind.${kind}`)
}
