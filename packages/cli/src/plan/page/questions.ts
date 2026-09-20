/** The open questions above the tabs, and the answers the export carries (RFC 0030 §4). */

import type { PlanFeedback } from '../feedback'
import type { PlanQuestion } from '../schema'
import { card, dependsMarks, linkLine } from './card'
import { byId, el } from './dom'
import { ariaLabel, tel } from './locale'

interface Answer {
  questionId: string
  option: string | null
  text: string
  badge: HTMLElement
}

// A list, not a map keyed by the question id: two questions may declare the same
// id (`guren check` reports it, and the page still renders), and a map would keep
// one of them while both sets of handlers went on writing to their own.
const answers: Answer[] = []

/** RFC 0030 §4: an assumption nobody confirmed is not an answer. */
function answered(answer: Answer): boolean {
  return answer.option !== null || answer.text !== ''
}

/**
 * The badge and the "depends on" marks are derived from the answers, so they are
 * refreshed rather than updated. Also called once after the cards exist, since a
 * question's marks live on the elements it affects and those render later.
 */
export function refreshAnswers(): void {
  for (const answer of answers) {
    const settled = answered(answer)
    answer.badge.hidden = settled
    for (const mark of dependsMarks[answer.questionId] ?? []) mark.hidden = settled
  }
}

/** Only what someone actually answered: an unconfirmed assumption would reach `plan --revise` as a decision. */
export function givenAnswers(): PlanFeedback['answers'] {
  return answers.filter(answered).map((given) => {
    const answer: PlanFeedback['answers'][number] = { questionId: given.questionId }
    if (given.option !== null) answer.option = given.option
    if (given.text !== '') answer.text = given.text
    return answer
  })
}

function questionCard(question: PlanQuestion, questionIndex: number): HTMLElement {
  // `option` stays null until someone picks one: the assumed answer is
  // preselected so the plan reads the way it was written, and RFC 0030 §4 is
  // explicit that silence is not an answer.
  const answer: Answer = {
    questionId: question.id,
    option: null,
    text: '',
    badge: tel('span', 'badge badge-alter', 'badge.unanswered'),
  }
  answers.push(answer)

  const body = el('div')
  const fieldset = el('fieldset', 'bare')
  fieldset.appendChild(tel('legend', 'note', 'questions.options'))
  for (const option of question.options) {
    const label = el('label', 'question-option')
    const radio = el('input')
    radio.type = 'radio'
    // The index, not the id: two questions sharing an id would otherwise put
    // their options in one radio group and answer each other.
    radio.name = 'question-' + questionIndex
    radio.checked = option.label === question.assumed
    const choose = (): void => {
      if (!radio.checked) return
      answer.option = option.label
      refreshAnswers()
    }
    // `click` as well as `change`: clicking the preselected option is how
    // someone confirms the assumption, and that fires no `change`.
    radio.addEventListener('change', choose)
    radio.addEventListener('click', choose)
    label.appendChild(radio)
    label.appendChild(document.createTextNode(' ' + option.label))
    if (option.label === question.assumed) {
      label.appendChild(document.createTextNode(' '))
      label.appendChild(tel('span', 'badge badge-existing', 'badge.assumed'))
    }
    label.appendChild(el('span', 'consequence', option.consequence))
    fieldset.appendChild(label)
  }
  body.appendChild(fieldset)

  const answerLabel = el('label', 'question-answer')
  answerLabel.appendChild(tel('span', 'note', 'questions.answer'))
  const answerBox = el('textarea')
  answerBox.rows = 2
  ariaLabel(answerBox, 'questions.answerTo', { id: question.id })
  answerBox.addEventListener('input', () => {
    answer.text = answerBox.value
    refreshAnswers()
  })
  answerLabel.appendChild(answerBox)
  body.appendChild(answerLabel)

  if (question.affects.length) body.appendChild(linkLine('questions.affects', question.affects))

  return card({
    id: question.id,
    title: question.question,
    body: body,
    extraBadges: [answer.badge],
    noReview: true,
    noFilter: true,
  })
}

export function renderQuestions(questions: readonly PlanQuestion[]): void {
  if (!questions.length) return
  const panel = el('section', 'panel')
  panel.appendChild(tel('h2', null, 'questions.heading'))
  panel.appendChild(tel('p', 'note', 'questions.note'))
  questions.forEach((question, index) => {
    panel.appendChild(questionCard(question, index))
  })
  byId('questions').appendChild(panel)
}
