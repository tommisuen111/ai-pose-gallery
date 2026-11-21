import { useEffect, useRef } from 'react'

interface Props {
  yaw: number
  pitch: number
  onChange: (view: { yaw: number; pitch: number }) => void
  size?: number
}

const RAD = Math.PI / 180

const MARKS: { label: string; dir: [number, number, number]; view: { yaw: number; pitch: number }; color: string }[] = [
  { label: '前', dir: [0, 0, 1], view: { yaw: 0, pitch: 0 }, color: '#16a34a' },
  { label: '后', dir: [0, 0, -1], view: { yaw: 180, pitch: 0 }, color: '#64748b' },
  { label: '左', dir: [1, 0, 0], view: { yaw: 90, pitch: 0 }, color: '#2f7df6' },
  { label: '右', dir: [-1, 0, 0], view: { yaw: -90, pitch: 0 }, color: '#ef4444' },
  { label: '顶', dir: [0, 1, 0], view: { yaw: 0, pitch: 89 }, color: '#f59e0b' },
  { label: '底', dir: [0, -1, 0], view: { yaw: 0, pitch: -89 }, color: '#a855f7' },
]

/** 世界方向 → 相机视图坐标（x 右、y 上、z 朝向观察者） */
function toView(d: [number, number, number], yaw: number, pitch: number): [number, number, number] {
  const sy = Math.sin(yaw * RAD)
  const cy = Math.cos(yaw * RAD)
  const sp = Math.sin(pitch * RAD)
  const cp = Math.cos(pitch * RAD)
  return [
    d[0] * cy - d[2] * sy,
    -d[0] * sy * sp + d[1] * cp - d[2] * cy * sp,
    d[0] * sy * cp + d[1] * sp + d[2] * cy * cp,
  ]
}

/**
 * 视角球：拖动球体旋转相机，点击「前/后/左/右/顶/底」标记直接切到对应视角。
 * 标记表示「从人物的哪一侧看过去」。
 */
export function ViewBall({ yaw, pitch, onChange, size = 148 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const state = useRef({ yaw, pitch })
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  useEffect(() => {
    state.current = { yaw, pitch }
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    const c = size / 2
    const R = size / 2 - 15

    const grad = ctx.createRadialGradient(c - R * 0.35, c - R * 0.4, R * 0.1, c, c, R)
    grad.addColorStop(0, 'rgba(255,255,255,0.95)')
    grad.addColorStop(1, 'rgba(176,184,198,0.9)')
    ctx.beginPath()
    ctx.arc(c, c, R, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
    ctx.strokeStyle = 'rgba(71,85,105,0.55)'
    ctx.lineWidth = 1
    ctx.stroke()

    // 三个大圆（经纬线），正面实线、背面虚淡
    const circles: ((t: number) => [number, number, number])[] = [
      (t) => [Math.cos(t), 0, Math.sin(t)],
      (t) => [0, Math.cos(t), Math.sin(t)],
      (t) => [Math.cos(t), Math.sin(t), 0],
    ]
    for (const fn of circles) {
      for (const front of [false, true]) {
        ctx.beginPath()
        let pen = false
        for (let i = 0; i <= 72; i++) {
          const v = toView(fn((i / 72) * Math.PI * 2), yaw, pitch)
          if (v[2] >= 0 === front) {
            const x = c + v[0] * R
            const y = c - v[1] * R
            if (pen) ctx.lineTo(x, y)
            else ctx.moveTo(x, y)
            pen = true
          } else pen = false
        }
        ctx.strokeStyle = front ? 'rgba(51,65,85,0.5)' : 'rgba(51,65,85,0.13)'
        ctx.lineWidth = front ? 1.1 : 1
        ctx.stroke()
      }
    }

    const marks = MARKS.map((m) => ({ m, v: toView(m.dir, yaw, pitch) })).sort((a, b) => a.v[2] - b.v[2])
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const { m, v } of marks) {
      const front = v[2] >= -0.05
      const x = c + v[0] * R
      const y = c - v[1] * R
      const r = front ? 10.5 : 8
      ctx.globalAlpha = front ? 1 : 0.42
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = m.color
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = `600 ${front ? 11 : 9}px system-ui, sans-serif`
      ctx.fillText(m.label, x, y + 0.5)
    }
    ctx.globalAlpha = 1
  }, [yaw, pitch, size])

  const hitMark = (x: number, y: number) => {
    const c = size / 2
    const R = size / 2 - 15
    let best: (typeof MARKS)[number] | null = null
    let bestZ = -Infinity
    for (const m of MARKS) {
      const v = toView(m.dir, state.current.yaw, state.current.pitch)
      if (Math.hypot(c + v[0] * R - x, c - v[1] * R - y) <= 12 && v[2] > bestZ) {
        best = m
        bestZ = v[2]
      }
    }
    return best
  }

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="视角球：拖动旋转视角，点击标记切换到对应方向"
      style={{ width: size, height: size, touchAction: 'none' }}
      className="shrink-0 cursor-grab select-none active:cursor-grabbing"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        drag.current = { x: e.clientX - r.left, y: e.clientY - r.top, moved: false }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const r = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - r.left
        const y = e.clientY - r.top
        if (!d.moved && Math.hypot(x - d.x, y - d.y) < 3) return
        d.moved = true
        const k = 90 / (size / 2 - 15)
        // 先在本地累加，避免两次重绘之间的快速移动被丢掉
        state.current = { yaw: state.current.yaw - (x - d.x) * k, pitch: Math.max(-89, Math.min(89, state.current.pitch + (y - d.y) * k)) }
        onChange(state.current)
        d.x = x
        d.y = y
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        if (d && !d.moved) {
          const m = hitMark(d.x, d.y)
          if (m) onChange(m.view)
        }
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
    />
  )
}
