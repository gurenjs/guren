import { useEffect, useRef, useState, type CSSProperties } from 'react'

const NAME = '紅蓮'
const BURN_MS = 1800
// Past 1 the front has left the top of the text and the rim has faded out.
const END = 1.12

// The burnt-in colour, bottom to top. The shader and the text it hands back to
// both read these, so the hand-over cannot change colour.
const STOPS = [
  { at: 0, hex: '#ffb35c' },
  { at: 0.38, hex: '#ff3c28' },
  { at: 1, hex: '#db1b1b' },
] as const

const TEXT_FILL: CSSProperties = {
  backgroundImage: `linear-gradient(to top, ${STOPS.map((stop) => `${stop.hex} ${stop.at * 100}%`).join(', ')})`,
}

function glslColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => (Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3))
  return `vec3(${r}, ${g}, ${b})`
}

const [LOW, MID, HIGH] = STOPS

const VERTEX = `
attribute vec2 a;
varying vec2 v;
void main() {
  v = a * 0.5 + 0.5;
  gl_Position = vec4(a, 0.0, 1.0);
}`

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v;
uniform sampler2D uMask;
uniform sampler2D uGlow;
uniform float uProgress;
uniform float uTime;
uniform float uAspect;
uniform vec2 uText;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 p = vec2(v.x * uAspect, v.y);
  float mask = texture2D(uMask, v).a;
  float ty = clamp((v.y - uText.x) / (uText.y - uText.x), 0.0, 1.0);
  float active = 1.0 - smoothstep(1.0, ${END.toFixed(2)}, uProgress);

  float front = mix(uText.x - 0.1, uText.y + 0.1, uProgress);
  float edge = v.y + (fbm(p * 4.5 + vec2(0.0, -uTime * 0.7)) - 0.5) * 0.2;
  float d = front - edge;

  float shown = smoothstep(0.0, 0.01, d);
  float rim = smoothstep(-0.003, 0.0, d) * (1.0 - smoothstep(0.0, 0.075, d)) * active;

  vec3 base = ty < ${MID.at.toFixed(2)}
    ? mix(${glslColor(LOW.hex)}, ${glslColor(MID.hex)}, ty / ${MID.at.toFixed(2)})
    : mix(${glslColor(MID.hex)}, ${glslColor(HIGH.hex)}, (ty - ${MID.at.toFixed(2)}) / ${(HIGH.at - MID.at).toFixed(2)});
  vec3 hot = mix(vec3(1.0, 0.97, 0.85), vec3(1.0, 0.5, 0.14), smoothstep(0.0, 0.06, d));
  vec3 ink = mix(base, hot, rim);
  float inkA = mask * shown;

  // Flames and sparks exist only just above the front; skip their noise elsewhere.
  float above = -d;
  float tongue = 0.0;
  float band = step(0.0, above) * (1.0 - smoothstep(0.0, 0.24, above)) * active;
  if (band > 0.0) {
    float source = texture2D(uGlow, v - vec2(0.0, above * 0.85)).a;
    float lick = fbm(vec2(p.x * 7.0, p.y * 2.2 - uTime * 2.6));
    tongue = smoothstep(0.34, 0.85, lick * source * 2.4) * band;
  }
  float spark = 0.0;
  float sparkBand = step(0.0, above) * (1.0 - smoothstep(0.0, 0.3, above)) * active;
  if (sparkBand > 0.0) {
    float sparkField = noise(vec2(p.x * 70.0, p.y * 70.0 - uTime * 9.0));
    spark = step(0.992, sparkField) * sparkBand * smoothstep(0.02, 0.2, texture2D(uGlow, v - vec2(0.0, above)).a);
  }

  float halo = texture2D(uGlow, v).a * exp(-abs(d) * 20.0) * active;

  vec3 fire = mix(vec3(0.9, 0.18, 0.05), vec3(1.0, 0.82, 0.45), tongue);
  vec3 color = ink * inkA + vec3(1.0, 0.42, 0.1) * halo * 0.85 + fire * tongue + vec3(1.0, 0.85, 0.55) * spark;
  float alpha = clamp(inkA + halo * 0.65 + tongue * 0.9 + spark, 0.0, 1.0);
  gl_FragColor = vec4(min(color, vec3(alpha)), alpha);
}`

interface Burn {
  draw(progress: number, seconds: number): void
  dispose(): void
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null
}

function glyphCanvas(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) draw(ctx)
  return canvas
}

/** Lays the name out on the canvas, one glyph per em box, and returns a renderer for any progress. */
function createBurn(canvas: HTMLCanvasElement, glyph: number, family: string): Burn | null {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, depth: false })
  if (!gl) return null
  const release = () => gl.getExtension('WEBGL_lose_context')?.loseContext()

  const pad = glyph * 0.5
  // Every effect offsets its texture reads vertically only, so nothing is drawn
  // wider than the glyph plus its glow.
  const cssWidth = glyph * 1.5
  const cssHeight = glyph * NAME.length + pad * 2
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`
  canvas.width = Math.round(cssWidth * ratio)
  canvas.height = Math.round(cssHeight * ratio)

  const size = glyph * ratio
  const layout = (ctx: CanvasRenderingContext2D, dx = 0) => {
    ctx.font = `700 ${size}px ${family}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#fff'
    Array.from(NAME).forEach((char, i) => {
      ctx.fillText(char, canvas.width / 2 + dx, pad * ratio + size * (i + 0.5))
    })
  }
  const mask = glyphCanvas(canvas.width, canvas.height, (ctx) => layout(ctx))
  // A shadow is the portable blur: ctx.filter is missing from older Safari.
  const glow = glyphCanvas(canvas.width, canvas.height, (ctx) => {
    ctx.shadowColor = '#fff'
    ctx.shadowBlur = size * 0.1
    ctx.shadowOffsetX = canvas.width * 4
    layout(ctx, -canvas.width * 4)
  })

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  const program = gl.createProgram()
  if (!vertex || !fragment || !program) {
    release()
    return null
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    release()
    return null
  }
  gl.useProgram(program)

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'a')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

  // The shader reads only alpha, so the glyphs upload at a quarter of RGBA's size.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  ;[mask, glow].forEach((source, unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, source)
    source.width = 0
  })

  gl.uniform1i(gl.getUniformLocation(program, 'uMask'), 0)
  gl.uniform1i(gl.getUniformLocation(program, 'uGlow'), 1)
  gl.uniform1f(gl.getUniformLocation(program, 'uAspect'), cssWidth / cssHeight)
  gl.uniform2f(gl.getUniformLocation(program, 'uText'), pad / cssHeight, 1 - pad / cssHeight)
  const progressAt = gl.getUniformLocation(program, 'uProgress')
  const timeAt = gl.getUniformLocation(program, 'uTime')
  gl.viewport(0, 0, canvas.width, canvas.height)

  return {
    draw(progress, seconds) {
      gl.uniform1f(progressAt, progress)
      gl.uniform1f(timeAt, seconds)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    // Losing the context frees its buffer, program and textures in one call.
    dispose: release,
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

type Phase = 'pending' | 'burning' | 'static'

/**
 * 紅蓮 burnt in once when it first comes into view, then left as plain text.
 * Without WebGL, or under reduced motion, the text shows from the start.
 */
export function BurningName() {
  const textRef = useRef<HTMLSpanElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('pending')

  useEffect(() => {
    const text = textRef.current
    const canvas = canvasRef.current
    if (
      !text
      || !canvas
      || typeof IntersectionObserver === 'undefined'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setPhase('static')
      return
    }

    // The canvas draws the face the text shows, so both read one computed style.
    const { fontFamily, fontSize } = getComputedStyle(text)
    let burn: Burn | null = null
    let frame = 0
    let cancelled = false
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      observer.disconnect()
      const created = createBurn(canvas, Number.parseFloat(fontSize), fontFamily)
      if (!created) {
        setPhase('static')
        return
      }
      burn = created
      setPhase('burning')
      const started = performance.now()
      const tick = (now: number) => {
        if (cancelled) return
        const t = (now - started) / BURN_MS
        created.draw(easeInOut(Math.min(t, 1)) * END, (now - started) / 1000)
        if (t < 1) {
          frame = requestAnimationFrame(tick)
          return
        }
        // The finished name goes back to the text, which stays sharp under
        // zoom and resize, and the canvas's GPU memory goes with it.
        created.dispose()
        burn = null
        setPhase('static')
      }
      frame = requestAnimationFrame(tick)
    })

    const start = () => {
      if (!cancelled) observer.observe(canvas)
    }
    void document.fonts.load(`700 16px ${fontFamily}`, NAME).then(start, start)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      burn?.dispose()
    }
  }, [])

  return (
    <span className="relative block">
      <span
        ref={textRef}
        lang="ja"
        style={TEXT_FILL}
        className={`block bg-clip-text font-mincho text-[9.5rem] font-bold leading-none text-transparent [writing-mode:vertical-rl] ${
          phase === 'burning' ? 'invisible' : phase === 'pending' ? 'guren-name-pending' : ''
        }`}
      >
        {NAME}
      </span>
      {phase !== 'static' && (
        <canvas
          ref={canvasRef}
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ${phase === 'burning' ? '' : 'invisible'}`}
        />
      )}
    </span>
  )
}
