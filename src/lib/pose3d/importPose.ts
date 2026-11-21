import type { PoseItem } from '@/types/gallery'
import { retarget, type Landmark, type ViewAngles } from './retarget'
import type { FigurePose } from './rig'

/**
 * 图库姿势 → 3D 人偶。
 * data/pose3d.json 由 scripts/pose3d 离线生成：把同一姿势 5 个机位的图做多视角三角测量，
 * 每组姿势得到一份世界坐标系下的 33 点关键点（双人姿势为两份）。
 */
interface Pose3dFile {
  version: number
  /** 五个机位的相机角度，键为图片 id 的后缀（front / high / low / side / diag） */
  views: Record<string, ViewAngles>
  groups: Record<string, { f: number[][]; n: number }>
}

const FALLBACK_VIEWS: Record<string, ViewAngles> = {
  正面: { yaw: 0, pitch: 4 },
  俯视: { yaw: 0, pitch: 38 },
  仰视: { yaw: 0, pitch: -30 },
  侧面: { yaw: -90, pitch: 4 },
  斜侧: { yaw: -42, pitch: 4 },
}

/** 人偶肩髋距离（米），用来把关键点的尺度换算到人偶尺度 */
const RIG_TORSO = 0.44

let cache: Promise<Pose3dFile> | null = null

function loadFile(): Promise<Pose3dFile> {
  cache ??= fetch('/data/pose3d.json')
    .then((res) => {
      if (!res.ok) throw new Error(`加载 3D 姿势数据失败: HTTP ${res.status}`)
      return res.json() as Promise<Pose3dFile>
    })
    .catch((err) => {
      cache = null
      throw err
    })
  return cache
}

function unpack(w: number[]): Landmark[] {
  const out: Landmark[] = []
  for (let i = 0; i + 3 < w.length; i += 4) out.push([w[i], w[i + 1], w[i + 2], w[i + 3]])
  return out
}

const mid = (a: Landmark, b: Landmark) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]

export interface ImportedPose {
  figures: FigurePose[]
  view: ViewAngles
}

/** 读取图库姿势对应的 3D 关节数据；该姿势没有可用数据时返回 null */
export async function importGalleryPose(item: PoseItem): Promise<ImportedPose | null> {
  const file = await loadFile()
  const m = item.id.match(/^(.*)_([a-z]+)$/)
  if (!m) return null
  const group = file.groups[m[1]]
  if (!group?.f.length) return null
  const view = file.views[m[2]] ?? FALLBACK_VIEWS[item.角度] ?? FALLBACK_VIEWS.正面
  const people = group.f.map(unpack)
  const first = people[0]
  const torso = Math.hypot(...mid(first[11], first[12]).map((v, i) => v - mid(first[23], first[24])[i]))
  const scale = torso > 0.2 ? Math.min(1.25, Math.max(0.7, RIG_TORSO / torso)) : 1
  const figures = people.map((lm) => {
    const pose = retarget(lm)
    // 多人时保持彼此的相对位置（关键点原点在第一个人物的髋部）
    const hip = mid(lm[23], lm[24])
    pose.pos = [pose.pos[0] + hip[0] * scale, pose.pos[1] + hip[1] * scale, pose.pos[2] + hip[2] * scale]
    return pose
  })
  return { figures, view }
}
