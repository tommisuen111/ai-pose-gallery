import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * 程序化球形关节人偶（素体）。
 * 坐标约定：Y 向上，人物面朝 +Z，人物左手在 +X。
 * 所有骨骼旋转为单位四元数时是 T 字姿势（手心向下、拇指朝前）。
 */

export const JOINTS = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'lUpperArm', 'lForearm', 'lHand',
  'rUpperArm', 'rForearm', 'rHand',
  'lThigh', 'lShin', 'lFoot',
  'rThigh', 'rShin', 'rFoot',
] as const

export type JointId = (typeof JOINTS)[number]
export type Quat = [number, number, number, number]
export type Vec3 = [number, number, number]
export type BodyType = 'female' | 'male'

export interface FigurePose {
  /** 髋部（根）世界坐标 */
  pos: Vec3
  rot: Partial<Record<JointId, Quat>>
  body?: BodyType
}

export const JOINT_LABELS: Record<JointId, string> = {
  hips: '髋部', spine: '腰部', chest: '胸腔', neck: '颈部', head: '头部',
  lUpperArm: '左上臂', lForearm: '左前臂', lHand: '左手',
  rUpperArm: '右上臂', rForearm: '右前臂', rHand: '右手',
  lThigh: '左大腿', lShin: '左小腿', lFoot: '左脚',
  rThigh: '右大腿', rShin: '右小腿', rFoot: '右脚',
}

export const PARENT: Record<JointId, JointId | null> = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  lUpperArm: 'chest', lForearm: 'lUpperArm', lHand: 'lForearm',
  rUpperArm: 'chest', rForearm: 'rUpperArm', rHand: 'rForearm',
  lThigh: 'hips', lShin: 'lThigh', lFoot: 'lShin',
  rThigh: 'hips', rShin: 'rThigh', rFoot: 'rShin',
}

interface Dims {
  hipW: number
  shoulderW: number
  waistW: number
  chestW: number
  limb: number
  bust: number
}

const DIMS: Record<BodyType, Dims> = {
  female: { hipW: 1.08, shoulderW: 0.165, waistW: 0.86, chestW: 0.9, limb: 0.92, bust: 1 },
  male: { hipW: 0.95, shoulderW: 0.2, waistW: 1.02, chestW: 1.1, limb: 1.06, bust: 0 },
}

const UPPER_ARM = 0.27
const FOREARM = 0.24
const THIGH = 0.42
const SHIN = 0.4
export const HIPS_HEIGHT = 0.945

function offsets(d: Dims): Record<JointId, Vec3> {
  return {
    hips: [0, HIPS_HEIGHT, 0],
    spine: [0, 0.09, 0],
    chest: [0, 0.15, 0],
    neck: [0, 0.26, 0],
    head: [0, 0.09, 0],
    lUpperArm: [d.shoulderW, 0.2, 0],
    lForearm: [UPPER_ARM, 0, 0],
    lHand: [FOREARM, 0, 0],
    rUpperArm: [-d.shoulderW, 0.2, 0],
    rForearm: [-UPPER_ARM, 0, 0],
    rHand: [-FOREARM, 0, 0],
    lThigh: [0.085, -0.05, 0],
    lShin: [0, -THIGH, 0],
    lFoot: [0, -SHIN, 0],
    rThigh: [-0.085, -0.05, 0],
    rShin: [0, -THIGH, 0],
    rFoot: [0, -SHIN, 0],
  }
}

/** 末端虚拟点（指尖、脚尖、头顶），用于拖拽朝向 */
export const TIPS = {
  lHandTip: { joint: 'lHand', offset: [0.16, 0, 0] },
  rHandTip: { joint: 'rHand', offset: [-0.16, 0, 0] },
  lToe: { joint: 'lFoot', offset: [0, -0.05, 0.17] },
  rToe: { joint: 'rFoot', offset: [0, -0.05, 0.17] },
  headTop: { joint: 'head', offset: [0, 0.24, 0] },
} as const satisfies Record<string, { joint: JointId; offset: Vec3 }>

export type TipId = keyof typeof TIPS
export type HandleId = JointId | TipId

export const HANDLES: HandleId[] = [...JOINTS, ...(Object.keys(TIPS) as TipId[])]

export function isTip(id: HandleId): id is TipId {
  return id in TIPS
}

/** 拖拽/点击控制点时被选中的骨骼 */
export function handleJoint(id: HandleId): JointId {
  return isTip(id) ? TIPS[id].joint : id
}

// ---------- 几何体 ----------

function ell(rx: number, ry: number, rz: number, cx = 0, cy = 0, cz = 0): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 28, 20)
  g.scale(rx, ry, rz)
  g.translate(cx, cy, cz)
  return g
}

const UP = new THREE.Vector3(0, 1, 0)

function limb(from: Vec3, to: Vec3, rFrom: number, rTo: number): THREE.BufferGeometry {
  const a = new THREE.Vector3(...from)
  const b = new THREE.Vector3(...to)
  const dir = b.clone().sub(a)
  const len = dir.length()
  const g = new THREE.CylinderGeometry(rTo, rFrom, len, 24, 1, false)
  g.translate(0, len / 2, 0)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()))
  g.translate(a.x, a.y, a.z)
  return g
}

/**
 * 合并一根骨骼上的多个部件。每个部件带一个编号（写入顶点属性 pid），
 * 线稿渲染时不同编号的部件之间会描出分界线；想让两个部件连成一体就给相同编号。
 */
function merged(parts: (THREE.BufferGeometry | [THREE.BufferGeometry, number])[]): THREE.BufferGeometry {
  const clean = parts.map((entry, i) => {
    const [p, id] = Array.isArray(entry) ? entry : [entry, i]
    const g = p.index ? p.toNonIndexed() : p
    g.deleteAttribute('uv')
    g.setAttribute('pid', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(id), 1))
    return g
  })
  return mergeGeometries(clean, false)
}

function boneGeometry(id: JointId, d: Dims): THREE.BufferGeometry {
  const s = id.startsWith('r') ? -1 : 1
  const L = d.limb
  switch (id) {
    case 'hips':
      return merged([ell(0.158 * d.hipW, 0.118, 0.112, 0, -0.005, -0.004)])
    case 'spine':
      return merged([ell(0.122 * d.waistW, 0.125, 0.094, 0, 0.06, 0)])
    case 'chest': {
      const parts: [THREE.BufferGeometry, number][] = [
        [ell(0.152 * d.chestW, 0.165, 0.11, 0, 0.115, -0.004), 0],
        [ell(d.shoulderW * 0.9, 0.058, 0.072, 0, 0.215, -0.008), 0],
      ]
      if (d.bust > 0) {
        parts.push([ell(0.058, 0.058, 0.054, 0.068, 0.112, 0.074), 1], [ell(0.058, 0.058, 0.054, -0.068, 0.112, 0.074), 2])
      }
      return merged(parts)
    }
    case 'neck':
      return merged([limb([0, -0.03, 0], [0, 0.1, 0.005], 0.047 * L, 0.042 * L)])
    case 'head':
      return merged([
        [ell(0.093, 0.122, 0.104, 0, 0.115, 0.012), 0],
        [ell(0.07, 0.07, 0.07, 0, 0.055, 0.03), 0],
        [ell(0.014, 0.022, 0.02, 0, 0.085, 0.118), 0],
      ])
    case 'lUpperArm':
    case 'rUpperArm':
      return merged([ell(0.057 * L, 0.057 * L, 0.057 * L), limb([0, 0, 0], [s * UPPER_ARM, 0, 0], 0.05 * L, 0.04 * L)])
    case 'lForearm':
    case 'rForearm':
      return merged([ell(0.043 * L, 0.043 * L, 0.043 * L), limb([0, 0, 0], [s * FOREARM, 0, 0], 0.04 * L, 0.027 * L)])
    case 'lHand':
    case 'rHand':
      return merged([
        ell(0.03 * L, 0.03 * L, 0.03 * L),
        [ell(0.075, 0.018, 0.04, s * 0.088, 0, 0), 1],
        [ell(0.036, 0.013, 0.015, s * 0.055, -0.004, 0.048), 1],
      ])
    case 'lThigh':
    case 'rThigh':
      return merged([ell(0.09 * L, 0.09 * L, 0.09 * L), limb([0, 0, 0], [0, -THIGH, 0], 0.086 * L, 0.057 * L)])
    case 'lShin':
    case 'rShin':
      return merged([ell(0.06 * L, 0.06 * L, 0.06 * L), limb([0, 0, 0], [0, -SHIN, 0], 0.056 * L, 0.034 * L)])
    case 'lFoot':
    case 'rFoot':
      return merged([ell(0.038 * L, 0.038 * L, 0.038 * L), ell(0.044, 0.03, 0.115, 0, -0.045, 0.062)])
  }
}

/** 头部朝向参考线（面部十字线），线稿与白模中显示 */
function faceLines(): THREE.BufferGeometry {
  const pts: number[] = []
  const c = new THREE.Vector3(0, 0.115, 0.012)
  const r = new THREE.Vector3(0.093, 0.122, 0.104).multiplyScalar(1.012)
  const at = (yaw: number, pitch: number) =>
    new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * r.x, Math.sin(pitch) * r.y, Math.cos(yaw) * Math.cos(pitch) * r.z).add(c)
  const seg = (a: THREE.Vector3, b: THREE.Vector3) => pts.push(a.x, a.y, a.z, b.x, b.y, b.z)
  const N = 16
  for (let i = 0; i < N; i++) {
    // 垂直中线（额头到下巴）
    seg(at(0, 1.2 - (2.1 * i) / N), at(0, 1.2 - (2.1 * (i + 1)) / N))
    // 眼线（水平）
    seg(at(-1.25 + (2.5 * i) / N, -0.08), at(-1.25 + (2.5 * (i + 1)) / N, -0.08))
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return g
}

// ---------- 材质 ----------

export type RenderStyle = 'line' | 'shaded' | 'depth'

/** 部件编号材质：把「人物序号 + 骨骼序号 + 部件编号」写进红色通道，供线稿描边使用 */
function idMaterial(base: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uBase: { value: base } },
    vertexShader: `attribute float pid; uniform float uBase; varying float vId;
      void main(){ vId = uBase + pid; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vId;
      void main(){ gl_FragColor = vec4((floor(vId + 0.5) + 1.0) / 255.0, 0.0, 0.0, 1.0); }`,
  })
}

export const FACE_LINE_ID = 250

function depthMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uNear: { value: 1 }, uFar: { value: 5 } },
    vertexShader: `varying float vZ;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uNear; uniform float uFar; varying float vZ;
      void main(){
        float t = clamp((vZ - uNear) / max(uFar - uNear, 0.0001), 0.0, 1.0);
        float v = mix(0.97, 0.22, t);
        gl_FragColor = vec4(vec3(v), 1.0);
      }`,
  })
}

export interface StyleMaterials {
  line: THREE.Material
  shaded: THREE.Material
  depth: THREE.ShaderMaterial
  faceLine: THREE.LineBasicMaterial
}

export function createMaterials(): StyleMaterials {
  return {
    line: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    shaded: new THREE.MeshStandardMaterial({ color: 0xe9e6e1, roughness: 0.72, metalness: 0 }),
    depth: depthMaterial(),
    faceLine: new THREE.LineBasicMaterial({ color: 0x1a1a1f }),
  }
}

// ---------- 人偶 ----------

export class Mannequin {
  readonly root = new THREE.Group()
  readonly bones = {} as Record<JointId, THREE.Group>
  body: BodyType
  private meshes: THREE.Mesh[] = []
  private idMats = new Map<THREE.Mesh, THREE.ShaderMaterial>()
  private faceId = new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB((FACE_LINE_ID + 1) / 255, 0, 0, THREE.LinearSRGBColorSpace) })
  private style: RenderStyle = 'line'
  /** 人物序号，决定线稿描边时的编号区间 */
  index = 0
  private face: THREE.LineSegments | null = null
  private mats: StyleMaterials

  constructor(mats: StyleMaterials, body: BodyType = 'female') {
    this.mats = mats
    this.body = body
    for (const id of JOINTS) {
      const g = new THREE.Group()
      g.name = id
      this.bones[id] = g
    }
    for (const id of JOINTS) {
      const p = PARENT[id]
      if (p) this.bones[p].add(this.bones[id])
      else this.root.add(this.bones[id])
    }
    this.build()
  }

  private build() {
    for (const m of this.meshes) {
      m.parent?.remove(m)
      m.geometry.dispose()
      this.idMats.get(m)?.dispose()
    }
    this.idMats.clear()
    if (this.face) {
      this.face.parent?.remove(this.face)
      this.face.geometry.dispose()
    }
    this.meshes = []
    const d = DIMS[this.body]
    const off = offsets(d)
    for (const id of JOINTS) {
      const bone = this.bones[id]
      if (id !== 'hips') bone.position.set(...off[id])
      const geo = boneGeometry(id, d)
      const mesh = new THREE.Mesh(geo, this.mats[this.style])
      bone.add(mesh)
      this.meshes.push(mesh)
      this.idMats.set(mesh, idMaterial(JOINTS.indexOf(id) * 4))
    }
    this.face = new THREE.LineSegments(faceLines(), this.mats.faceLine)
    this.face.visible = this.style !== 'depth'
    this.bones.head.add(this.face)
  }

  /** 切到「部件编号」渲染（线稿描边的第一遍），再调用 setStyle 还原 */
  setIdPass() {
    for (const m of this.meshes) {
      const mat = this.idMats.get(m)!
      mat.uniforms.uBase.value = this.index * 80 + (mat.uniforms.uBase.value % 80)
      m.material = mat
    }
    if (this.face) {
      this.face.material = this.faceId
      this.face.visible = true
    }
  }

  setBody(body: BodyType) {
    if (body === this.body) return
    this.body = body
    this.build()
  }

  setStyle(style: RenderStyle) {
    this.style = style
    const mat = this.mats[style]
    for (const m of this.meshes) m.material = mat
    if (this.face) {
      this.face.material = this.mats.faceLine
      this.face.visible = style === 'shaded'
    }
  }

  setVisible(v: boolean) {
    this.root.visible = v
  }

  getPose(): FigurePose {
    const rot: Partial<Record<JointId, Quat>> = {}
    for (const id of JOINTS) {
      const q = this.bones[id].quaternion
      rot[id] = [round(q.x), round(q.y), round(q.z), round(q.w)]
    }
    const p = this.bones.hips.position
    return { pos: [round(p.x), round(p.y), round(p.z)], rot, body: this.body }
  }

  setPose(pose: FigurePose) {
    if (pose.body) this.setBody(pose.body)
    this.bones.hips.position.set(...pose.pos)
    for (const id of JOINTS) {
      const q = pose.rot[id]
      if (q) this.bones[id].quaternion.set(q[0], q[1], q[2], q[3]).normalize()
      else this.bones[id].quaternion.identity()
    }
    this.root.updateMatrixWorld(true)
  }

  handlePosition(id: HandleId, out = new THREE.Vector3()): THREE.Vector3 {
    if (isTip(id)) {
      const t = TIPS[id]
      return this.bones[t.joint].localToWorld(out.set(...(t.offset as Vec3)))
    }
    return this.bones[id].getWorldPosition(out)
  }

  /** 网格包围盒（世界坐标） */
  bounds(out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty()
    this.root.updateMatrixWorld(true)
    const box = new THREE.Box3()
    for (const m of this.meshes) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      box.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld)
      out.union(box)
    }
    return out
  }

  /** 每个部件各自的包围盒（世界坐标），取景时比整体包围盒更贴合 */
  partBounds(): THREE.Box3[] {
    this.root.updateMatrixWorld(true)
    return this.meshes.map((m) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      return m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld)
    })
  }

  /** 精确最低点（逐顶点），用于落地 */
  lowestY(): number {
    this.root.updateMatrixWorld(true)
    let min = Infinity
    const v = new THREE.Vector3()
    for (const m of this.meshes) {
      const pos = m.geometry.getAttribute('position')
      for (let i = 0; i < pos.count; i += 3) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
        if (v.y < min) min = v.y
      }
    }
    return min
  }

  snapToGround() {
    const y = this.lowestY()
    if (Number.isFinite(y)) this.bones.hips.position.y -= y
    this.root.updateMatrixWorld(true)
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose()
    for (const m of this.idMats.values()) m.dispose()
    this.faceId.dispose()
    this.face?.geometry.dispose()
    this.root.removeFromParent()
  }
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

// ---------- 姿势工具 ----------

const E = (x: number, y: number, z: number, order: THREE.EulerOrder = 'XYZ'): Quat => {
  const r = Math.PI / 180
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x * r, y * r, z * r, order))
  return [round(q.x), round(q.y), round(q.z), round(q.w)]
}

export function mirrorQuat(q: Quat): Quat {
  return [q[0], -q[1], -q[2], q[3]]
}

/** 左右镜像整个姿势 */
export function mirrorPose(pose: FigurePose): FigurePose {
  const rot: Partial<Record<JointId, Quat>> = {}
  for (const id of JOINTS) {
    const q = pose.rot[id]
    if (!q) continue
    const target = (id.startsWith('l') ? `r${id.slice(1)}` : id.startsWith('r') ? `l${id.slice(1)}` : id) as JointId
    rot[target] = mirrorQuat(q)
  }
  return { pos: [-pose.pos[0], pose.pos[1], pose.pos[2]], rot, body: pose.body }
}

function symmetric(left: Partial<Record<string, Quat>>, center: Partial<Record<JointId, Quat>> = {}): Partial<Record<JointId, Quat>> {
  const rot: Partial<Record<JointId, Quat>> = { ...center }
  for (const [k, q] of Object.entries(left)) {
    if (!q) continue
    rot[`l${k}` as JointId] = q
    rot[`r${k}` as JointId] = mirrorQuat(q)
  }
  return rot
}

export interface PosePreset {
  id: string
  name: string
  pose: FigurePose
}

export const PRESETS: PosePreset[] = [
  {
    id: 'stand',
    name: '自然站立',
    pose: {
      pos: [0, HIPS_HEIGHT, 0],
      rot: symmetric({ UpperArm: E(0, 0, -76), Forearm: E(0, -12, 0), Hand: E(0, 0, 0), Thigh: E(0, 0, 2) }),
    },
  },
  { id: 'tpose', name: 'T 字', pose: { pos: [0, HIPS_HEIGHT, 0], rot: {} } },
  {
    id: 'walk',
    name: '迈步',
    pose: {
      pos: [0, HIPS_HEIGHT - 0.02, 0],
      rot: {
        spine: E(2, -6, 0),
        chest: E(0, -8, 0),
        head: E(0, 10, 0),
        lUpperArm: E(0, -32, -72, 'ZYX'),
        lForearm: E(0, -25, 0),
        rUpperArm: E(0, -28, 74, 'ZYX'),
        rForearm: E(0, 30, 0),
        lThigh: E(22, 0, 0),
        lShin: E(18, 0, 0),
        lFoot: E(-6, 0, 0),
        rThigh: E(-30, 0, 0),
        rShin: E(8, 0, 0),
        rFoot: E(14, 0, 0),
      },
    },
  },
  {
    id: 'sit',
    name: '坐姿',
    pose: {
      pos: [0, 0.52, 0],
      rot: {
        ...symmetric({ UpperArm: E(0, -18, -66, 'ZYX'), Forearm: E(0, -38, 0), Thigh: E(-86, 0, 4), Shin: E(88, 0, 0) }),
        spine: E(3, 0, 0),
      },
    },
  },
  {
    id: 'kneel',
    name: '跪坐',
    pose: {
      pos: [0, 0.36, 0],
      rot: {
        ...symmetric({ UpperArm: E(0, -30, -70, 'ZYX'), Forearm: E(0, -35, 0), Thigh: E(-80, 0, 6), Shin: E(152, 0, 0), Foot: E(62, 0, 0) }),
        spine: E(2, 0, 0),
      },
    },
  },
  {
    id: 'hips',
    name: '叉腰',
    pose: {
      pos: [0, HIPS_HEIGHT, 0],
      rot: {
        ...symmetric({ UpperArm: E(0, 28, -52, 'ZYX'), Forearm: E(0, -112, 0), Hand: E(0, 0, 0), Thigh: E(0, 0, 7) }),
        hips: E(0, 0, 0),
      },
    },
  },
]

export function defaultPose(): FigurePose {
  return structuredClone(PRESETS[0].pose)
}
