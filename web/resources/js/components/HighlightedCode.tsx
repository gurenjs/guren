interface HighlightedCodeProps {
  code: string
  lang?: string
}

export function HighlightedCode({ code, lang = 'typescript' }: HighlightedCodeProps) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-white/10 bg-[#120d0d] p-4 font-mono text-sm leading-relaxed text-white/85 shadow-inner shadow-black/20">
      <div className="mb-3 flex items-center justify-between text-[11px] uppercase tracking-[0.24em] text-white/35">
        <span>{lang}</span>
        <span>typed</span>
      </div>
      <code className="block whitespace-pre text-white/82">{code}</code>
    </pre>
  )
}
