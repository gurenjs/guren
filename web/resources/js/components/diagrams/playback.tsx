import { useEffect, useState } from 'react'

export interface PlaybackLabels {
  play: string
  pause: string
  replay: string
}

/** A position that advances one step every `intervalMs` while running and stops on the last. */
export function usePlayback(length: number, intervalMs: number, initial = 0) {
  const [position, setPosition] = useState(initial)
  const [playing, setPlaying] = useState(false)
  const finished = position === length - 1
  const running = playing && !finished

  useEffect(() => {
    if (!running) return
    const timer = setTimeout(() => setPosition((value) => value + 1), intervalMs)
    return () => clearTimeout(timer)
  }, [running, position, intervalMs])

  const start = (from: number) => {
    setPosition(from)
    setPlaying(true)
  }

  const toggle = () => {
    if (running) setPlaying(false)
    else start(finished ? 0 : position)
  }

  const seek = (index: number) => {
    setPlaying(false)
    setPosition(index)
  }

  return { position, running, finished, start, toggle, seek }
}

// No aria-pressed: the label already says what a press does, and a toggle button keeps its label.
export function PlayButton({ running, finished, labels, onToggle }: {
  running: boolean
  finished: boolean
  labels: PlaybackLabels
  onToggle: () => void
}) {
  return (
    <button type="button" className="doc-diagram-play" onClick={onToggle}>
      <span aria-hidden="true">{running ? '❚❚' : '▶'}</span>
      {running ? labels.pause : finished ? labels.replay : labels.play}
    </button>
  )
}
