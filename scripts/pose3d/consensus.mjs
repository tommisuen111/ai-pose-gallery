// 多视角三角测量：图库里每个姿势都有 5 个机位的图。单张图估计出的「深度」不可靠，
// 但各图里关节的 2D 位置是可靠的。这里用已知机位把多张图的 2D 关节反推成一份 3D 关键点
// （33 点 BlazePose 拓扑，世界坐标：Y 向上、人物大致面朝 +Z、单位约为米）。
import * as THREE from 'three'

const RAD = Math.PI / 180

/** 图库五个机位（度）。yaw：0 正面，负值转向人物右侧；pitch：正值俯视 */
export const VIEW_PRESETS = {
  front: { yaw: 0, pitch: 5 },
  high: { yaw: 0, pitch: 38 },
  low: { yaw: 0, pitch: -28 },
  side: { yaw: -80, pitch: 2 },
  diag: { yaw: -42, pitch: 4 },
}

export function camQ(view) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(-view.pitch * RAD, view.yaw * RAD, 0, 'YXZ'))
}

function camAxes(view) {
  const q = camQ(view)
  return { right: new THREE.Vector3(1, 0, 0).applyQuaternion(q), up: new THREE.Vector3(0, 1, 0).applyQuaternion(q), q }
}

// BlazePose 左右对应点
const SWAP = [0, 4, 5, 6, 1, 2, 3, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17, 20, 19, 22, 21, 24, 23, 26, 25, 28, 27, 30, 29, 32, 31]
const BODY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
const JOINT_WEIGHT = Array.from({ length: 33 }, (_, i) => (i <= 10 ? 0.5 : i <= 16 ? 1 : i <= 22 ? 0.35 : i <= 28 ? 1 : 0.6))
const IMAGE_ASPECT = 0.75

/** raw: { w: 33×[x,y,z,vis]（相机坐标，y 上、z 朝相机）, l: 33×[x,y]（归一化图像坐标） } */
export function unpack(raw) {
  const pts = []
  const vis = []
  const uv = []
  for (let i = 0; i < 33; i++) {
    pts.push(new THREE.Vector3(raw.w[i * 4], raw.w[i * 4 + 1], raw.w[i * 4 + 2]))
    vis.push(raw.w[i * 4 + 3])
    uv.push([(raw.l[i * 2] - 0.5) * IMAGE_ASPECT, 0.5 - raw.l[i * 2 + 1]])
  }
  return { pts, vis, uv }
}

function swapped(p) {
  return { pts: SWAP.map((i) => p.pts[i]), vis: SWAP.map((i) => p.vis[i]), uv: SWAP.map((i) => p.uv[i]) }
}

export function score(p) {
  return BODY.reduce((a, i) => a + p.vis[i], 0) / BODY.length
}

/** 弱透视拟合：uv ≈ s·proj(P) + t，返回 { s, t, err（米） } */
function fitCamera(axes, corr) {
  let W = 0
  let px = 0
  let py = 0
  let qx = 0
  let qy = 0
  for (const c of corr) {
    c.x = axes.right.dot(c.P)
    c.y = axes.up.dot(c.P)
    W += c.w
    px += c.w * c.x
    py += c.w * c.y
    qx += c.w * c.uv[0]
    qy += c.w * c.uv[1]
  }
  if (W < 1e-6) return null
  px /= W
  py /= W
  qx /= W
  qy /= W
  let num = 0
  let den = 0
  for (const c of corr) {
    num += c.w * ((c.x - px) * (c.uv[0] - qx) + (c.y - py) * (c.uv[1] - qy))
    den += c.w * ((c.x - px) ** 2 + (c.y - py) ** 2)
  }
  if (den < 1e-9 || num <= 0) return null
  const s = num / den
  const t = [qx - s * px, qy - s * py]
  let err = 0
  for (const c of corr) {
    c.rx = s * c.x + t[0] - c.uv[0]
    c.ry = s * c.y + t[1] - c.uv[1]
    err += c.w * (c.rx * c.rx + c.ry * c.ry)
  }
  return { s, t, err: Math.sqrt(err / W) / s }
}

function solve3(A, b) {
  const m = [
    [A[0], A[1], A[2], b[0]],
    [A[1], A[3], A[4], b[1]],
    [A[2], A[4], A[5], b[2]],
  ]
  for (let i = 0; i < 3; i++) {
    let p = i
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r
    ;[m[i], m[p]] = [m[p], m[i]]
    if (Math.abs(m[i][i]) < 1e-12) return null
    for (let r = 0; r < 3; r++) {
      if (r === i) continue
      const f = m[r][i] / m[i][i]
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c]
    }
  }
  return new THREE.Vector3(m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2])
}

function torso(P) {
  const sh = P[11].clone().add(P[12]).multiplyScalar(0.5)
  const hip = P[23].clone().add(P[24]).multiplyScalar(0.5)
  return sh.distanceTo(hip) + P[11].distanceTo(P[12]) + P[23].distanceTo(P[24])
}

/** 人体结构投票：标注的左右是否与解剖结构一致（膝盖向后弯、肘向前弯、脚尖朝前） */
function handednessVote(P, vis) {
  const X = P[23].clone().sub(P[24]).add(P[11].clone().sub(P[12])).normalize()
  const U = P[11].clone().add(P[12]).sub(P[23]).sub(P[24]).normalize()
  const F = X.clone().cross(U).normalize()
  let vote = 0
  const bend = (a, b, c, sign, weight) => {
    if (Math.min(vis[a], vis[b], vis[c]) < 0.5) return
    const t = P[b].clone().sub(P[a]).normalize()
    const s = P[c].clone().sub(P[b]).normalize()
    const axis = t.cross(s)
    if (axis.length() < 0.25) return
    vote += sign * weight * axis.dot(X)
  }
  bend(23, 25, 27, 1, 1)
  bend(24, 26, 28, 1, 1)
  bend(11, 13, 15, -1, 0.45)
  bend(12, 14, 16, -1, 0.45)
  for (const [heel, toe] of [[29, 31], [30, 32]]) {
    if (Math.min(vis[heel], vis[toe]) < 0.5) continue
    vote += 0.5 * P[toe].clone().sub(P[heel]).normalize().dot(F)
  }
  return { vote, F }
}

/**
 * views: { [view]: [variant → [person, …]] }，person = unpack() 的结果
 * persons: 人数（1 或 2）
 * 返回 { people: [{ pts, vis }], offsets, inlierViews, err } 或 null
 */
export function triangulate(observations, persons = 1, presets = VIEW_PRESETS, opts = {}) {
  const obs = observations
    .map((o) => ({ ...o, people: o.people.filter((p) => score(p) >= 0.35), axes: camAxes(presets[o.view]) }))
    .filter((o) => o.people.length)
  if (!obs.length) return null
  const K = persons === 2 && obs.some((o) => o.people.length >= 2) ? 2 : 1

  const seeds = [...obs]
    .filter((o) => o.people.length >= K)
    .sort((a, b) => seedScore(b, K) - seedScore(a, K))
    .slice(0, opts.seeds ?? 4)

  let best = null
  for (const seed of seeds) {
    const sol = solveFrom(seed, obs, K, opts)
    if (!sol) continue
    if (!best || sol.quality > best.quality) best = sol
  }
  return best
}

function seedScore(o, K) {
  const s = o.people.slice(0, K).reduce((a, p) => a + score(p), 0) / K
  return s + (o.view === 'front' ? 0.1 : o.view === 'diag' ? 0.05 : 0)
}

function solveFrom(seed, obs, K, opts) {
  // 初值：种子观测的单目 3D（转到世界坐标），第二个人按图中相对位置摆放
  const P = []
  const seedPeople = [...seed.people].sort((a, b) => score(b) - score(a)).slice(0, K)
  seedPeople.forEach((p, k) => {
    const world = p.pts.map((v) => v.clone().applyQuaternion(seed.axes.q))
    if (k > 0) {
      const corr = BODY.map((i) => ({ P: seedPeople[0].pts[i].clone().applyQuaternion(seed.axes.q), uv: seedPeople[0].uv[i], w: 1 }))
      const fit = fitCamera(seed.axes, corr)
      const s = fit?.s ?? 0.5
      const hipUv = (q) => [(q.uv[23][0] + q.uv[24][0]) / 2, (q.uv[23][1] + q.uv[24][1]) / 2]
      const a = hipUv(seedPeople[0])
      const b = hipUv(p)
      const hipA = seedPeople[0].pts[23].clone().add(seedPeople[0].pts[24]).multiplyScalar(0.5).applyQuaternion(seed.axes.q)
      const hipB = world[23].clone().add(world[24]).multiplyScalar(0.5)
      const shift = hipA
        .clone()
        .addScaledVector(seed.axes.right, (b[0] - a[0]) / s)
        .addScaledVector(seed.axes.up, (b[1] - a[1]) / s)
        .sub(hipB)
      for (const v of world) v.add(shift)
    }
    P.push(world)
  })
  const scale0 = torso(P[0])
  const maxErr = opts.maxErr ?? 0.07
  const combos = K === 1 ? [[0]] : [[0, 1], [1, 0]]
  let chosen = []

  for (let iter = 0; iter < 14; iter++) {
    const tol = iter < 4 ? maxErr * 2.2 : iter < 8 ? maxErr * 1.5 : maxErr
    chosen = []
    for (const o of obs) {
      let bestFit = null
      // 观测里的每个人对应到哪个人物、是否左右互换
      const dets = o.people.slice(0, 2)
      const assigns = K === 1 ? dets.map((_, i) => [i]) : dets.length >= 2 ? combos : [[0, -1], [-1, 0]]
      for (const assign of assigns) {
        // assign[k] = 人物 k 用第几个检测（-1 表示这张图里没有）
        const picks = K === 1 ? [[0, dets[assign[0]]]] : assign.map((d, k) => (d >= 0 ? [k, dets[d]] : null)).filter(Boolean)
        const flipChoices = picks.length === 1 ? [[false], [true]] : [[false, false], [true, false], [false, true], [true, true]]
        for (const flips of flipChoices) {
          const corr = []
          picks.forEach(([k, det], j) => {
            const d = flips[j] ? swapped(det) : det
            for (let i = 0; i < 33; i++) {
              const w = d.vis[i] >= 0.3 ? d.vis[i] * JOINT_WEIGHT[i] : 0
              if (w > 0) corr.push({ P: P[k][i], uv: d.uv[i], w, k, i })
            }
          })
          if (corr.length < 8) continue
          const fit = fitCamera(o.axes, corr)
          if (!fit) continue
          if (!bestFit || fit.err < bestFit.fit.err) bestFit = { fit, corr, o }
        }
      }
      if (bestFit && bestFit.fit.err <= tol) chosen.push(bestFit)
    }
    const viewsIn = new Set(chosen.map((c) => c.o.view))
    if (viewsIn.size < 2) break

    // 逐点最小二乘
    for (let k = 0; k < K; k++) {
      for (let i = 0; i < 33; i++) {
        const A = [0, 0, 0, 0, 0, 0]
        const b = [0, 0, 0]
        let W = 0
        for (const c of chosen) {
          const item = c.corr.find((x) => x.k === k && x.i === i)
          if (!item) continue
          const res = Math.hypot(item.rx, item.ry) / c.fit.s
          const w = item.w / (1 + (res / 0.05) ** 2)
          W += w
          for (const [axis, target] of [[c.o.axes.right, (item.uv[0] - c.fit.t[0]) / c.fit.s], [c.o.axes.up, (item.uv[1] - c.fit.t[1]) / c.fit.s]]) {
            A[0] += w * axis.x * axis.x
            A[1] += w * axis.x * axis.y
            A[2] += w * axis.x * axis.z
            A[3] += w * axis.y * axis.y
            A[4] += w * axis.y * axis.z
            A[5] += w * axis.z * axis.z
            b[0] += w * axis.x * target
            b[1] += w * axis.y * target
            b[2] += w * axis.z * target
          }
        }
        // 先验：轻微拉向上一轮的位置，避免只有相近机位时深度发散
        const lambda = 0.03 * W + 1e-4
        const prev = P[k][i]
        A[0] += lambda
        A[3] += lambda
        A[5] += lambda
        b[0] += lambda * prev.x
        b[1] += lambda * prev.y
        b[2] += lambda * prev.z
        const next = solve3(A, b)
        if (next) P[k][i] = next
      }
    }
    // 固定尺度与原点
    const f = scale0 / torso(P[0])
    const hip = P[0][23].clone().add(P[0][24]).multiplyScalar(0.5)
    for (const pts of P) for (let i = 0; i < 33; i++) pts[i] = pts[i].clone().sub(hip).multiplyScalar(f)
  }

  const inlierViews = new Set(chosen.map((c) => c.o.view))
  if (inlierViews.size < 2) return null
  const err = chosen.reduce((a, c) => a + c.fit.err, 0) / chosen.length

  const people = P.map((pts, k) => {
    const vis = Array.from({ length: 33 }, (_, i) => {
      let seen = 0
      let max = 0
      for (const c of chosen) {
        const item = c.corr.find((x) => x.k === k && x.i === i)
        if (!item) continue
        seen++
        max = Math.max(max, item.w / JOINT_WEIGHT[i])
      }
      return seen >= 2 ? max : max * 0.5
    })
    return { pts, vis }
  })

  // 左右标注与解剖结构相反时整体互换
  for (const p of people) {
    const { vote } = handednessVote(p.pts, p.vis)
    p.vote = vote
    if (vote < -0.15) {
      p.pts = SWAP.map((i) => p.pts[i])
      p.vis = SWAP.map((i) => p.vis[i])
      p.swapped = true
    }
  }

  return { people, inlierViews: [...inlierViews], used: chosen.length, err, quality: inlierViews.size * 10 + chosen.length - err * 100, K }
}
