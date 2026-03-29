interface CodeBlockProps {
  lines: string[]
  title?: string
}

export function CodeBlock({ lines, title = 'Terminal' }: CodeBlockProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#1a1212] shadow-2xl">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <div className="flex gap-1.5">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="ml-2 text-xs font-medium text-white/40">{title}</span>
      </div>
      <div className="p-5 font-mono text-sm leading-relaxed">
        {lines.map((line, i) => (
          <div key={i} className="text-white/80">
            {line.startsWith('$') ? (
              <>
                <span className="text-crimson-400">$</span>
                <span className="text-white">{line.slice(1)}</span>
              </>
            ) : (
              <span className="text-white/50">{line}</span>
            )}
          </div>
        ))}
        <span className="inline-block h-4 w-2 animate-cursor-blink bg-crimson-400" />
      </div>
    </div>
  )
}
