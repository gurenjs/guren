import { Fragment, useState } from 'react'

function useCopy(text: string): [boolean, () => Promise<void>] {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable; the text is still selectable by hand.
    }
  }
  return [copied, copy]
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, copy] = useCopy(command)

  return (
    <button
      type="button"
      onClick={copy}
      className="group inline-flex max-w-full items-center gap-2 rounded-md border border-white/15 bg-ink px-4 py-3 text-left font-mono text-[13px] text-crimson-50 transition hover:border-crimson-300/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crimson-300 sm:gap-3 sm:text-sm"
      aria-label={`Copy command: ${command}`}
    >
      <span className="select-none text-crimson-400">$</span>
      {/* Break between words only: the hyphens in create-guren-app are line-break opportunities. */}
      <span className="min-w-0">
        {command.split(' ').map((word, i) => (
          <Fragment key={i}>
            {i > 0 && ' '}
            <span className="whitespace-nowrap">{word}</span>
          </Fragment>
        ))}
      </span>
      <span className="select-none text-xs text-smoke/70 transition group-hover:text-smoke">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
}

/** A multi-line block (shell lines or a prompt) with one copy button for all of it. */
export function CopyBlock({ text, label, prompt = false }: { text: string; label: string; prompt?: boolean }) {
  const [copied, copy] = useCopy(text)

  return (
    <div className="relative rounded-md border border-white/15 bg-ink">
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 rounded px-2 py-1 text-xs text-smoke/70 transition hover:text-smoke focus-visible:outline-2 focus-visible:outline-crimson-300"
        aria-label={`Copy ${label}`}
      >
        {copied ? 'copied' : 'copy'}
      </button>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 pr-16 font-mono text-[13px] leading-[1.7] text-crimson-50 sm:text-sm">
        {prompt
          ? text
          : text.split('\n').map((line, i) => (
              <Fragment key={i}>
                <span className="select-none text-crimson-400">$ </span>
                {line}
                {'\n'}
              </Fragment>
            ))}
      </pre>
    </div>
  )
}
