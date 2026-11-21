// 第一步：逐张图库姿势图提取人体关键点（离线运行一次，约 25 分钟）。
//
// 线稿白模直接识别不出来，这里把深度图加上法线明暗和肤色后再交给 MediaPipe Pose（heavy 模型），
// 每张图保留三种预处理的结果，供第二步 build.mjs 做多视角三角测量。
//
// 依赖不进 package.json，按需临时安装：
//   npm i --no-save playwright-core @mediapipe/tasks-vision
//   npx playwright-core install chromium-headless-shell
//   curl -L -o /tmp/pose_landmarker_heavy.task \
//     https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task
// 用法：
//   POSE_MODEL=/tmp/pose_landmarker_heavy.task node scripts/pose3d/extract.mjs /tmp/raw.json
//   node scripts/pose3d/build.mjs /tmp/raw.json
// 可选环境变量 CHROMIUM 指定浏览器可执行文件。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '../..')
const outPath = process.argv[2]
const model = process.env.POSE_MODEL
if (!outPath || !model || !fs.existsSync(model)) throw new Error('用法：POSE_MODEL=<heavy 模型路径> node scripts/pose3d/extract.mjs <输出 raw.json>')

const mounts = {
  '/mp/': path.join(root, 'node_modules/@mediapipe/tasks-vision/'),
  '/img/': path.join(root, 'img/'),
  '/t/': path.join(import.meta.dirname, '/'),
}
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp' }
const server = http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || '').split('?')[0])
    let file = url === '/model/pose_landmarker_heavy.task' ? model : ''
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (!file && url.startsWith(prefix)) {
        const f = path.join(dir, url.slice(prefix.length))
        if (f.startsWith(dir)) file = f
      }
    }
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  .listen(0)
const port = server.address().port

const poses = JSON.parse(fs.readFileSync(path.join(root, 'data/pose-zh.json'), 'utf8'))
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
const out = {}
let next = 0
let done = 0
async function worker() {
  const page = await browser.newPage()
  await page.goto(`http://localhost:${port}/t/extract.html`)
  await page.waitForFunction('window.ready')
  while (next < poses.length) {
    const item = poses[next++]
    const white = `/${item.原图}`
    const depth = white.replace('/img/', '/img/depth/').replace(/\.png$/, '.webp')
    try {
      out[item.id] = await page.evaluate(([w, d, n]) => window.run(w, d, n), [white, depth, item.体系 === '双人缠绵' ? 2 : 1])
    } catch (err) {
      out[item.id] = { err: String(err).slice(0, 120) }
    }
    if (++done % 100 === 0) console.log(`${done}/${poses.length}`)
  }
}
await Promise.all([worker(), worker(), worker()])
fs.writeFileSync(outPath, JSON.stringify(out))
await browser.close()
server.close()
console.log(`done: ${done} images → ${outPath}`)
