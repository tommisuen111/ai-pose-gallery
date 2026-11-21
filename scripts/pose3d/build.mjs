// 用法：node scripts/pose3d/build.mjs <raw.json> [输出文件，默认 data/pose3d.json]
// 把 extract.mjs 得到的逐图关键点做多视角三角测量，生成 3D 姿势生成器导入用的数据文件。
import fs from 'node:fs'
import path from 'node:path'
import { triangulate, unpack, VIEW_PRESETS } from './consensus.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const rawPath = process.argv[2]
if (!rawPath) throw new Error('缺少 raw.json 路径')
const outPath = process.argv[3] || path.join(root, 'data/pose3d.json')
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'))
const poses = JSON.parse(fs.readFileSync(path.join(root, 'data/pose-zh.json'), 'utf8'))

const groups = new Map()
for (const item of poses) {
  const m = item.id.match(/^(.*)_([a-z]+)$/)
  if (!m || !(m[2] in VIEW_PRESETS)) continue
  const g = groups.get(m[1]) ?? { pair: item.体系 === '双人缠绵', obs: [] }
  groups.set(m[1], g)
  const entry = raw[item.id]
  if (!entry || entry.err) continue
  for (const variant of Object.keys(entry)) {
    const people = entry[variant]
    if (Array.isArray(people) && people.length) g.obs.push({ view: m[2], variant, people: people.map(unpack) })
  }
}

const r3 = (n) => Math.round(n * 1000) / 1000
const out = { version: 2, views: VIEW_PRESETS, groups: {} }
let solved = 0
for (const [key, g] of groups) {
  const sol = triangulate(g.obs, g.pair ? 2 : 1)
  if (!sol) continue
  solved++
  out.groups[key] = {
    // 每个人物：33 点 × [x, y, z, 可信度]，世界坐标（米），原点在第一个人物的髋部中点
    f: sol.people.map((p) => p.pts.flatMap((v, i) => [r3(v.x), r3(v.y), r3(v.z), Math.round(Math.min(1, p.vis[i]) * 100) / 100])),
    n: sol.inlierViews.length,
  }
}
fs.writeFileSync(outPath, JSON.stringify(out))
console.log(`groups ${groups.size}, solved ${solved}, wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`)
