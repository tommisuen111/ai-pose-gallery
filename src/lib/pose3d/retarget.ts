import * as THREE from 'three'
import { JOINTS, PARENT, defaultPose, type FigurePose, type JointId, type Quat } from './rig'

/**
 * 把 33 点人体关键点（BlazePose 拓扑，相机坐标系）换算成人偶的骨骼旋转。
 * 关键点格式：[x, y, z, visibility]，x 向图像右、y 向上、z 朝向相机，单位约为米，原点在髋部中点。
 */
export type Landmark = [number, number, number, number]

export interface ViewAngles {
  /** 相机绕人物的水平角（度），0 为正面，正值转向人物左侧 */
  yaw: number
  /** 相机俯仰角（度），正值为俯视 */
  pitch: number
}

const LM = {
  nose: 0, lEar: 7, rEar: 8,
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
} as const

const X = new THREE.Vector3(1, 0, 0)
const Y = new THREE.Vector3(0, 1, 0)
const Z = new THREE.Vector3(0, 0, 1)
const NX = new THREE.Vector3(-1, 0, 0)
const NY = new THREE.Vector3(0, -1, 0)
const NZ = new THREE.Vector3(0, 0, -1)

/** 相机坐标系 → 世界坐标系的旋转 */
export function cameraBasis(view: ViewAngles): THREE.Quaternion {
  const r = Math.PI / 180
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(-view.pitch * r, view.yaw * r, 0, 'YXZ'))
}

function basis(primary: THREE.Vector3, secondary: THREE.Vector3): THREE.Matrix4 | null {
  const x = primary.clone().normalize()
  const z = x.clone().cross(secondary)
  if (z.lengthSq() < 1e-8) return null
  z.normalize()
  const y = z.clone().cross(x)
  return new THREE.Matrix4().makeBasis(x, y, z)
}

/** 由「主轴 + 辅助方向」求世界旋转：把静止姿态的这对方向转到目标方向 */
function solve(restP: THREE.Vector3, restS: THREE.Vector3, tgtP: THREE.Vector3, tgtS: THREE.Vector3): THREE.Quaternion | null {
  const a = basis(restP, restS)
  const b = basis(tgtP, tgtS)
  if (!a || !b) return null
  return new THREE.Quaternion().setFromRotationMatrix(b.multiply(a.transpose()))
}

/** 只摆动、不额外扭转：在父骨骼朝向基础上用最短弧对准目标方向 */
function swing(parent: THREE.Quaternion, restDir: THREE.Vector3, tgtDir: THREE.Vector3): THREE.Quaternion {
  const cur = restDir.clone().applyQuaternion(parent).normalize()
  const arc = new THREE.Quaternion().setFromUnitVectors(cur, tgtDir.clone().normalize())
  return arc.multiply(parent)
}

function sinBetween(a: THREE.Vector3, b: THREE.Vector3): number {
  return a.clone().normalize().cross(b.clone().normalize()).length()
}

const MIN_VIS = 0.35

export function retarget(landmarks: Landmark[], view: ViewAngles = { yaw: 0, pitch: 0 }): FigurePose {
  const camQ = cameraBasis(view)
  const P = landmarks.map((l) => new THREE.Vector3(l[0], l[1], l[2]).applyQuaternion(camQ))
  const vis = (...idx: number[]) => Math.min(...idx.map((i) => landmarks[i]?.[3] ?? 0)) >= MIN_VIS
  const dir = (a: number, b: number) => P[b].clone().sub(P[a])
  const mid = (a: number, b: number) => P[a].clone().add(P[b]).multiplyScalar(0.5)

  const fallback = defaultPose()
  const world: Partial<Record<JointId, THREE.Quaternion>> = {}

  // 躯干
  const hipMid = mid(LM.lHip, LM.rHip)
  const shMid = mid(LM.lShoulder, LM.rShoulder)
  const up = shMid.clone().sub(hipMid)
  const hasHips = vis(LM.lHip, LM.rHip)
  const hasShoulders = vis(LM.lShoulder, LM.rShoulder)
  const chestQ = hasShoulders ? solve(X, Y, dir(LM.rShoulder, LM.lShoulder), up) : null
  const hipsQ = hasHips ? solve(X, Y, dir(LM.rHip, LM.lHip), up) : null
  world.hips = hipsQ ?? chestQ ?? new THREE.Quaternion()
  world.chest = chestQ ?? world.hips.clone()
  world.spine = world.hips.clone().slerp(world.chest, 0.5)

  // 头颈
  let headQ: THREE.Quaternion | null = null
  if (vis(LM.lEar, LM.rEar, LM.nose)) {
    const earMid = mid(LM.lEar, LM.rEar)
    headQ = solve(X, Z, dir(LM.rEar, LM.lEar), P[LM.nose].clone().sub(earMid))
  }
  world.head = headQ ?? world.chest.clone()
  world.neck = world.chest.clone().slerp(world.head, 0.5)

  // 四肢
  for (const side of ['l', 'r'] as const) {
    const L = side === 'l'
    const sh = L ? LM.lShoulder : LM.rShoulder
    const el = L ? LM.lElbow : LM.rElbow
    const wr = L ? LM.lWrist : LM.rWrist
    const idx = L ? LM.lIndex : LM.rIndex
    const pinky = L ? LM.lPinky : LM.rPinky
    const armRest = L ? X : NX
    const upperArm = `${side}UpperArm` as JointId
    const forearm = `${side}Forearm` as JointId
    const hand = `${side}Hand` as JointId

    if (vis(sh, el)) {
      const a = dir(sh, el)
      const b = dir(el, wr)
      const bent = vis(wr) && sinBetween(a, b) > 0.3
      world[upperArm] = (bent ? solve(armRest, Z, a, b) : null) ?? swing(world.chest, armRest, a)
      if (vis(wr)) {
        const knuckles = dir(pinky, idx)
        const palmOk = vis(idx, pinky) && sinBetween(b, knuckles) > 0.3
        world[forearm] = (palmOk ? solve(armRest, Z, b, knuckles) : null) ?? swing(world[upperArm], armRest, b)
        if (vis(idx, pinky)) {
          const h = mid(idx, pinky).sub(P[wr])
          world[hand] = solve(armRest, Z, h, knuckles) ?? swing(world[forearm], armRest, h)
        }
      }
    }

    const hip = L ? LM.lHip : LM.rHip
    const knee = L ? LM.lKnee : LM.rKnee
    const ankle = L ? LM.lAnkle : LM.rAnkle
    const heel = L ? LM.lHeel : LM.rHeel
    const toe = L ? LM.lToe : LM.rToe
    const thigh = `${side}Thigh` as JointId
    const shin = `${side}Shin` as JointId
    const foot = `${side}Foot` as JointId

    if (vis(hip, knee)) {
      const a = dir(hip, knee)
      const b = dir(knee, ankle)
      const hasAnkle = vis(ankle)
      const bent = hasAnkle && sinBetween(a, b) > 0.3
      const footDir = dir(heel, toe)
      const hasFoot = hasAnkle && vis(heel, toe)
      world[thigh] =
        (bent ? solve(NY, NZ, a, b) : null) ??
        (hasFoot && sinBetween(a, footDir) > 0.3 ? solve(NY, Z, a, footDir) : null) ??
        swing(world.hips, NY, a)
      if (hasAnkle) {
        world[shin] = (hasFoot && sinBetween(b, footDir) > 0.3 ? solve(NY, Z, b, footDir) : null) ?? swing(world[thigh], NY, b)
        if (hasFoot) world[foot] = solve(Z, Y, footDir, dir(ankle, knee)) ?? world[shin].clone()
      }
    }
  }

  // 世界旋转 → 本地旋转；缺失的关节沿用默认站姿的本地旋转
  const rot: Partial<Record<JointId, Quat>> = {}
  const resolved = {} as Record<JointId, THREE.Quaternion>
  for (const id of JOINTS) {
    const parent = PARENT[id]
    const parentQ = parent ? resolved[parent] : new THREE.Quaternion()
    const w = world[id]
    let local: THREE.Quaternion
    if (w) {
      local = parentQ.clone().invert().multiply(w)
      resolved[id] = w
    } else {
      const q = fallback.rot[id]
      local = q ? new THREE.Quaternion(q[0], q[1], q[2], q[3]) : new THREE.Quaternion()
      // 末端骨骼（手、脚）缺失时跟随上一节，避免出现奇怪的折角
      if (/Hand|Foot|Forearm|Shin/.test(id) && world[parent as JointId]) local.identity()
      resolved[id] = parentQ.clone().multiply(local)
    }
    rot[id] = [r4(local.x), r4(local.y), r4(local.z), r4(local.w)]
  }

  return { pos: [0, fallback.pos[1], 0], rot }
}

function r4(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

/** 关键点整体可信度（0~1） */
export function landmarkScore(landmarks: Landmark[]): number {
  const core = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip, LM.lElbow, LM.rElbow, LM.lKnee, LM.rKnee]
  return core.reduce((a, i) => a + (landmarks[i]?.[3] ?? 0), 0) / core.length
}
