import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import {
  HANDLES,
  Mannequin,
  createMaterials,
  defaultPose,
  handleJoint,
  isTip,
  mirrorPose,
  type BodyType,
  type FigurePose,
  type HandleId,
  type JointId,
  type StyleMaterials,
  type Vec3,
} from './rig'

export type OutputStyle = 'line' | 'shaded' | 'depth' | 'openpose'

export interface CameraState {
  /** 水平角（度）：0 正面，正值转向人物左侧，±180 背面 */
  yaw: number
  /** 俯仰角（度）：正值俯视，负值仰视 */
  pitch: number
  dist: number
  fov: number
  target: Vec3
}

export interface SceneState {
  figures: FigurePose[]
  camera: CameraState
}

export interface Selection {
  figure: number
  joint: JointId
}

export interface StageEvents {
  /** 姿势发生了一次可撤销的修改 */
  onCommit?: () => void
  onCamera?: (camera: CameraState) => void
  onSelect?: (selection: Selection | null) => void
  onHistory?: (canUndo: boolean, canRedo: boolean) => void
  /** 第一帧画面已经画出 */
  onReady?: () => void
}

export const MAX_FIGURES = 2

export const DEFAULT_CAMERA: CameraState = { yaw: 0, pitch: 6, dist: 4.4, fov: 30, target: [0, 0.88, 0] }

const BACKGROUND: Record<OutputStyle, number> = {
  line: 0xffffff,
  shaded: 0xd8dade,
  depth: 0x000000,
  openpose: 0x000000,
}

const RAD = Math.PI / 180
const PICK_RADIUS = 15

type Drag =
  | { kind: 'orbit'; x: number; y: number; moved: boolean }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'handle'; figure: number; handle: HandleId; plane: THREE.Plane; offset: THREE.Vector3; moved: boolean; pins?: FootPin[] }

interface FootPin {
  side: 'l' | 'r'
  pos: THREE.Vector3
  quat: THREE.Quaternion
}

const FLEX_AXIS: Partial<Record<JointId, THREE.Vector3>> = {
  lForearm: new THREE.Vector3(0, -1, 0),
  rForearm: new THREE.Vector3(0, 1, 0),
  lShin: new THREE.Vector3(1, 0, 0),
  rShin: new THREE.Vector3(1, 0, 0),
}

/** 拖动某个控制点时，由哪根骨骼摆动来跟随 */
const AIM_PARENT: Partial<Record<HandleId, JointId>> = {
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  headTop: 'head',
  lForearm: 'lUpperArm',
  rForearm: 'rUpperArm',
  lHandTip: 'lHand',
  rHandTip: 'rHand',
  lShin: 'lThigh',
  rShin: 'rThigh',
  lToe: 'lFoot',
  rToe: 'rFoot',
  spine: 'hips',
}

/** 拖动手腕/脚踝时做两节反向运动（IK） */
const IK_CHAIN: Partial<Record<HandleId, [JointId, JointId]>> = {
  lHand: ['lUpperArm', 'lForearm'],
  rHand: ['rUpperArm', 'rForearm'],
  lFoot: ['lThigh', 'lShin'],
  rFoot: ['rThigh', 'rShin'],
}

function handleColor(id: HandleId): number {
  if (id.startsWith('l')) return 0x2f7df6
  if (id.startsWith('r')) return 0xef4444
  return 0xf59e0b
}

export class PoseStage {
  readonly renderer: THREE.WebGLRenderer
  private container: HTMLElement
  private overlay: HTMLCanvasElement
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(30, 0.75, 0.05, 100)
  private grid: THREE.GridHelper
  private mats: StyleMaterials
  private figures: Mannequin[] = []
  private handleMeshes: Map<HandleId, THREE.Mesh>[] = []
  private handleGeo = new THREE.SphereGeometry(1, 16, 12)
  private handleGroup = new THREE.Group()
  private tc: TransformControls
  private tcHelper: THREE.Object3D
  private cam: CameraState = structuredClone(DEFAULT_CAMERA)
  private style: OutputStyle = 'line'
  private selection: Selection | null = null
  private hover: { figure: number; handle: HandleId } | null = null
  private drag: Drag | null = null
  private history: string[] = []
  private historyIndex = -1
  private events: StageEvents
  private raf = 0
  private ro: ResizeObserver
  private width = 1
  private height = 1
  private disposed = false
  private showGrid = true
  private showHandles = true
  pinFeet = false

  constructor(container: HTMLElement, events: StageEvents = {}) {
    this.container = container
    this.events = events
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    const el = this.renderer.domElement
    el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none'
    container.appendChild(el)

    this.overlay = document.createElement('canvas')
    this.overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
    container.appendChild(this.overlay)

    this.mats = createMaterials()
    this.scene.add(this.camera)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f9c, 1.25))
    const key = new THREE.DirectionalLight(0xffffff, 1.9)
    key.position.set(-0.7, 0.9, 1)
    this.camera.add(key, key.target)
    key.target.position.set(0, 0, -1)

    this.grid = new THREE.GridHelper(8, 32, 0x9aa3b2, 0xd5d9e0)
    this.scene.add(this.grid)
    this.scene.add(this.handleGroup)

    this.tc = new TransformControls(this.camera, el)
    this.tc.setMode('rotate')
    this.tc.setSpace('local')
    this.tc.setSize(0.62)
    this.tcHelper = this.tc.getHelper()
    this.scene.add(this.tcHelper)
    this.tc.addEventListener('change', () => this.invalidate())
    this.tc.addEventListener('objectChange', () => this.syncHandles())
    this.tc.addEventListener('dragging-changed', (e) => {
      if (!(e as unknown as { value: boolean }).value) this.commit()
    })

    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointercancel', this.onPointerUp)
    el.addEventListener('pointerleave', this.onPointerLeave)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('contextmenu', this.onContextMenu)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()

    this.setFigures([defaultPose()])
    this.setStyle('line')
    this.applyCamera()
    this.resetHistory()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('pointercancel', this.onPointerUp)
    el.removeEventListener('pointerleave', this.onPointerLeave)
    el.removeEventListener('wheel', this.onWheel)
    el.removeEventListener('contextmenu', this.onContextMenu)
    this.tc.detach()
    this.tc.dispose()
    for (const f of this.figures) f.dispose()
    this.handleGeo.dispose()
    this.idTarget?.dispose()
    this.inkMaterial?.dispose()
    for (const m of Object.values(this.mats)) (m as THREE.Material).dispose()
    this.renderer.dispose()
    el.remove()
    this.overlay.remove()
  }

  // ---------- 状态 ----------

  getState(): SceneState {
    return { figures: this.figures.map((f) => f.getPose()), camera: structuredClone(this.cam) }
  }

  setState(state: SceneState, resetHistory = true) {
    this.setFigures(state.figures.length ? state.figures : [defaultPose()])
    this.cam = { ...structuredClone(DEFAULT_CAMERA), ...structuredClone(state.camera) }
    this.applyCamera()
    if (resetHistory) this.resetHistory()
  }

  get figureCount() {
    return this.figures.length
  }

  get activeFigure(): number {
    return Math.min(this.selection?.figure ?? this.active, this.figures.length - 1)
  }

  private active = 0

  setActiveFigure(index: number) {
    this.active = Math.max(0, Math.min(index, this.figures.length - 1))
    if (this.selection && this.selection.figure !== this.active) this.select(null)
    this.syncHandles()
  }

  getBody(): BodyType {
    return this.figures[this.activeFigure]?.body ?? 'female'
  }

  setFigures(poses: FigurePose[]) {
    this.select(null)
    while (this.figures.length > poses.length) this.dropFigure(this.figures.length - 1)
    poses.slice(0, MAX_FIGURES).forEach((pose, i) => {
      if (!this.figures[i]) this.createFigure()
      this.figures[i].setPose(pose)
    })
    this.active = Math.min(this.active, this.figures.length - 1)
    this.applyStyleToFigures()
    this.syncHandles()
  }

  private createFigure() {
    const fig = new Mannequin(this.mats)
    this.scene.add(fig.root)
    this.figures.push(fig)
    const map = new Map<HandleId, THREE.Mesh>()
    for (const id of HANDLES) {
      const mat = new THREE.MeshBasicMaterial({ color: handleColor(id), depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 })
      const mesh = new THREE.Mesh(this.handleGeo, mat)
      mesh.renderOrder = 20
      this.handleGroup.add(mesh)
      map.set(id, mesh)
    }
    this.handleMeshes.push(map)
  }

  private dropFigure(index: number) {
    const [fig] = this.figures.splice(index, 1)
    fig?.dispose()
    const [map] = this.handleMeshes.splice(index, 1)
    if (map) {
      for (const mesh of map.values()) {
        ;(mesh.material as THREE.Material).dispose()
        mesh.removeFromParent()
      }
    }
  }

  addFigure(pose?: FigurePose): boolean {
    if (this.figures.length >= MAX_FIGURES) return false
    const p = pose ?? defaultPose()
    if (!pose) p.pos[0] = this.figures[0] ? this.figures[0].bones.hips.position.x + 0.7 : 0
    this.createFigure()
    this.figures[this.figures.length - 1].setPose(p)
    this.active = this.figures.length - 1
    this.applyStyleToFigures()
    this.syncHandles()
    this.commit()
    return true
  }

  removeFigure(index = this.activeFigure): boolean {
    if (this.figures.length <= 1) return false
    this.select(null)
    this.dropFigure(index)
    this.active = 0
    this.syncHandles()
    this.commit()
    return true
  }

  applyPose(pose: FigurePose, index = this.activeFigure) {
    const fig = this.figures[index]
    if (!fig) return
    const cur = fig.bones.hips.position
    const next = structuredClone(pose)
    next.pos = [cur.x, next.pos[1], cur.z]
    next.body = fig.body
    fig.setPose(next)
    fig.snapToGround()
    this.syncHandles()
    this.commit()
  }

  mirror(index = this.activeFigure) {
    const fig = this.figures[index]
    if (!fig) return
    const cur = fig.getPose()
    const m = mirrorPose(cur)
    m.pos = cur.pos
    fig.setPose(m)
    this.syncHandles()
    this.commit()
  }

  setBody(body: BodyType, index = this.activeFigure) {
    const fig = this.figures[index]
    if (!fig || fig.body === body) return
    const sel = this.selection
    this.select(null)
    fig.setBody(body)
    this.applyStyleToFigures()
    if (sel) this.select(sel)
    this.syncHandles()
    this.commit()
  }

  /** 让人物最低点贴地。together 为真时所有人物整体平移（保持相对位置） */
  ground(together = false) {
    if (together) {
      const min = Math.min(...this.figures.map((f) => f.lowestY()))
      if (Number.isFinite(min)) for (const f of this.figures) f.bones.hips.position.y -= min
    } else {
      this.figures[this.activeFigure]?.snapToGround()
    }
    this.scene.updateMatrixWorld(true)
    this.syncHandles()
  }

  groundAndCommit() {
    this.ground(false)
    this.commit()
  }

  // ---------- 历史 ----------

  private snapshot(): string {
    return JSON.stringify(this.figures.map((f) => f.getPose()))
  }

  resetHistory() {
    this.history = [this.snapshot()]
    this.historyIndex = 0
    this.emitHistory()
  }

  private commit() {
    const snap = this.snapshot()
    if (snap !== this.history[this.historyIndex]) {
      this.history = this.history.slice(0, this.historyIndex + 1)
      this.history.push(snap)
      if (this.history.length > 100) this.history.shift()
      this.historyIndex = this.history.length - 1
      this.emitHistory()
    }
    this.events.onCommit?.()
    this.invalidate()
  }

  private emitHistory() {
    this.events.onHistory?.(this.historyIndex > 0, this.historyIndex < this.history.length - 1)
  }

  undo() {
    if (this.historyIndex <= 0) return
    this.restore(this.historyIndex - 1)
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return
    this.restore(this.historyIndex + 1)
  }

  private restore(index: number) {
    this.historyIndex = index
    const sel = this.selection
    this.setFigures(JSON.parse(this.history[index]) as FigurePose[])
    if (sel && sel.figure < this.figures.length) this.select(sel)
    this.emitHistory()
    this.events.onCommit?.()
    this.invalidate()
  }

  // ---------- 相机 ----------

  getCamera(): CameraState {
    return structuredClone(this.cam)
  }

  setCamera(patch: Partial<CameraState>) {
    Object.assign(this.cam, patch)
    this.applyCamera()
  }

  private applyCamera() {
    const c = this.cam
    c.pitch = Math.max(-89, Math.min(89, c.pitch))
    c.yaw = ((((c.yaw + 180) % 360) + 360) % 360) - 180
    c.dist = Math.max(0.6, Math.min(30, c.dist))
    c.fov = Math.max(8, Math.min(90, c.fov))
    const cp = Math.cos(c.pitch * RAD)
    const t = new THREE.Vector3(...c.target)
    this.camera.position.set(
      t.x + c.dist * Math.sin(c.yaw * RAD) * cp,
      t.y + c.dist * Math.sin(c.pitch * RAD),
      t.z + c.dist * Math.cos(c.yaw * RAD) * cp
    )
    this.camera.fov = c.fov
    this.camera.lookAt(t)
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld(true)
    this.syncHandles()
    this.events.onCamera?.(structuredClone(c))
  }

  /** 调整相机让所有人物完整入镜（保持当前视角方向），四周留一点边 */
  frame(margin = 0.88) {
    const corners: THREE.Vector3[] = []
    const box = new THREE.Box3()
    for (const f of this.figures) {
      for (const part of f.partBounds()) {
        for (let i = 0; i < 8; i++) {
          corners.push(new THREE.Vector3(i & 1 ? part.max.x : part.min.x, i & 2 ? part.max.y : part.min.y, i & 4 ? part.max.z : part.min.z))
        }
        box.union(part)
      }
    }
    if (!corners.length) return
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
    const back = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 2)
    const tanV = Math.tan((this.cam.fov * RAD) / 2) * margin
    const tanH = tanV * this.camera.aspect
    const target = box.getCenter(new THREE.Vector3())
    let dist = this.cam.dist
    const rel = new THREE.Vector3()
    // 透视下画面范围不对称，迭代几次把人物居中并贴合画幅
    for (let iter = 0; iter < 6; iter++) {
      dist = 0
      for (const c of corners) {
        rel.copy(c).sub(target)
        const z = rel.dot(back)
        dist = Math.max(dist, Math.abs(rel.dot(right)) / tanH + z, Math.abs(rel.dot(up)) / tanV + z)
      }
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const c of corners) {
        rel.copy(c).sub(target)
        const depth = dist - rel.dot(back)
        const x = rel.dot(right) / depth
        const y = rel.dot(up) / depth
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
      target.addScaledVector(right, ((minX + maxX) / 2) * dist).addScaledVector(up, ((minY + maxY) / 2) * dist)
    }
    this.cam.target = [target.x, target.y, target.z]
    this.cam.dist = dist
    this.applyCamera()
  }

  // ---------- 外观 ----------

  setStyle(style: OutputStyle) {
    this.style = style
    this.applyStyleToFigures()
    this.invalidate()
  }

  private applyStyleToFigures() {
    const s = this.style
    for (const f of this.figures) {
      f.setStyle(s === 'openpose' ? 'shaded' : s)
      f.setVisible(s !== 'openpose')
    }
    this.scene.background = new THREE.Color(BACKGROUND[s])
    this.grid.visible = this.showGrid && (s === 'line' || s === 'shaded')
    this.invalidate()
  }

  setGridVisible(v: boolean) {
    this.showGrid = v
    this.applyStyleToFigures()
  }

  setHandlesVisible(v: boolean) {
    this.showHandles = v
    this.syncHandles()
  }

  // ---------- 选择 ----------

  getSelection(): Selection | null {
    return this.selection
  }

  select(sel: Selection | null) {
    this.selection = sel
    if (sel && this.figures[sel.figure]) {
      this.active = sel.figure
      this.tc.attach(this.figures[sel.figure].bones[sel.joint])
    } else {
      this.selection = null
      this.tc.detach()
    }
    this.events.onSelect?.(this.selection)
    this.syncHandles()
  }

  /** 把选中关节恢复为无旋转 */
  resetSelectedJoint() {
    const sel = this.selection
    if (!sel) return
    this.figures[sel.figure].bones[sel.joint].quaternion.identity()
    this.scene.updateMatrixWorld(true)
    this.syncHandles()
    this.commit()
  }

  // ---------- 渲染 ----------

  private resize() {
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    this.width = w
    this.height = h
    this.renderer.setSize(w, h, false)
    const dpr = this.renderer.getPixelRatio()
    this.overlay.width = Math.round(w * dpr)
    this.overlay.height = Math.round(h * dpr)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.syncHandles()
  }

  invalidate() {
    if (this.raf || this.disposed) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.render()
    })
  }

  private idTarget: THREE.WebGLRenderTarget | null = null
  private inkScene: THREE.Scene | null = null
  private inkCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private inkMaterial: THREE.ShaderMaterial | null = null

  /**
   * 线稿渲染：先把每个部件按编号画到离屏缓冲，再在编号变化的地方描线。
   * 这样轮廓线和部件之间的分界线（关节球、胸腔、骨盆等）都会出现。
   */
  private renderLineArt(w: number, h: number, helpers: boolean) {
    const r = this.renderer
    if (!this.idTarget) {
      this.idTarget = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true })
      this.inkMaterial = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: { tId: { value: this.idTarget.texture }, uPx: { value: new THREE.Vector2() }, uR: { value: 1 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `uniform sampler2D tId; uniform vec2 uPx; uniform float uR; varying vec2 vUv;
          void main(){
            float c = texture2D(tId, vUv).r;
            float diff = 0.0;
            for (int i = 0; i < 12; i++) {
              float a = float(i) * 0.5235988;
              vec2 d = vec2(cos(a), sin(a)) * uPx * uR;
              diff += step(0.002, abs(texture2D(tId, vUv + d).r - c));
              diff += step(0.002, abs(texture2D(tId, vUv + d * 0.5).r - c));
            }
            float edge = clamp(diff / 24.0 * 2.7, 0.0, 1.0);
            bool inside = c > 0.002;
            if (!inside && edge < 0.01) discard;
            gl_FragColor = vec4(mix(vec3(1.0), vec3(0.07, 0.07, 0.09), edge), inside ? 1.0 : edge);
          }`,
      })
      this.inkScene = new THREE.Scene()
      this.inkScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.inkMaterial))
    }
    if (this.idTarget.width !== w || this.idTarget.height !== h) this.idTarget.setSize(w, h)
    this.inkMaterial!.uniforms.uPx.value.set(1 / w, 1 / h)
    this.inkMaterial!.uniforms.uR.value = Math.max(1, (h / 1200) * 1.9)

    const bg = this.scene.background
    const grid = this.grid.visible
    // 1. 部件编号
    this.figures.forEach((f, i) => {
      f.index = i
      f.setIdPass()
    })
    this.grid.visible = false
    this.handleGroup.visible = false
    this.tcHelper.visible = false
    this.scene.background = new THREE.Color(0x000000)
    r.setRenderTarget(this.idTarget)
    r.render(this.scene, this.camera)
    r.setRenderTarget(null)
    // 2. 背景与网格
    for (const f of this.figures) {
      f.setStyle('line')
      f.setVisible(false)
    }
    this.scene.background = bg
    this.grid.visible = helpers && grid
    r.render(this.scene, this.camera)
    // 3. 白模与描线
    const auto = r.autoClear
    r.autoClear = false
    r.render(this.inkScene!, this.inkCamera)
    // 4. 控制点与旋转环
    if (helpers) {
      this.grid.visible = false
      this.scene.background = null
      this.handleGroup.visible = true
      this.tcHelper.visible = this.selection !== null
      r.clearDepth()
      r.render(this.scene, this.camera)
    }
    r.autoClear = auto
    this.scene.background = bg
    this.grid.visible = grid
    this.handleGroup.visible = true
    this.tcHelper.visible = this.selection !== null
    for (const f of this.figures) f.setVisible(true)
  }

  private updateDepthRange() {
    const inv = this.camera.matrixWorldInverse
    let near = Infinity
    let far = -Infinity
    const box = new THREE.Box3()
    const v = new THREE.Vector3()
    for (const f of this.figures) {
      f.bounds(box)
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv)
        near = Math.min(near, -v.z)
        far = Math.max(far, -v.z)
      }
    }
    if (!Number.isFinite(near)) return
    this.mats.depth.uniforms.uNear.value = near
    this.mats.depth.uniforms.uFar.value = Math.max(far, near + 0.6)
  }

  private firstFrame = true

  private render() {
    if (this.disposed) return
    if (this.firstFrame) {
      this.firstFrame = false
      this.events.onReady?.()
    }
    this.camera.updateMatrixWorld(true)
    if (this.style === 'depth') this.updateDepthRange()
    if (this.style === 'line') {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
      this.renderLineArt(size.x, size.y, true)
    } else this.renderer.render(this.scene, this.camera)
    const ctx = this.overlay.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, this.overlay.width, this.overlay.height)
      if (this.style === 'openpose') this.drawOpenPose(ctx, this.overlay.width, this.overlay.height)
    }
  }

  private syncHandles() {
    if (!this.figures.length) return
    this.scene.updateMatrixWorld(true)
    const camPos = this.camera.position
    const k = (2 * Math.tan((this.camera.fov * RAD) / 2)) / Math.max(1, this.height)
    const p = new THREE.Vector3()
    this.figures.forEach((fig, fi) => {
      const map = this.handleMeshes[fi]
      for (const id of HANDLES) {
        const mesh = map.get(id)!
        fig.handlePosition(id, p)
        mesh.position.copy(p)
        const selected = this.selection?.figure === fi && this.selection.joint === id
        const hovered = this.hover?.figure === fi && this.hover.handle === id
        const px = (isTip(id) ? 4.2 : 5.6) * (selected ? 1.45 : hovered ? 1.3 : 1)
        mesh.scale.setScalar(p.distanceTo(camPos) * k * px)
        const mat = mesh.material as THREE.MeshBasicMaterial
        mat.color.setHex(selected ? 0x16a34a : handleColor(id))
        mat.opacity = fi === this.activeFigure || this.figures.length === 1 ? 0.92 : 0.5
        mesh.visible = this.showHandles
      }
    })
    this.invalidate()
  }

  // ---------- 交互 ----------

  private pointer(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private project(p: THREE.Vector3): { x: number; y: number; z: number } {
    const v = p.clone().project(this.camera)
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, z: v.z }
  }

  private pick(x: number, y: number): { figure: number; handle: HandleId } | null {
    if (!this.showHandles) return null
    let best: { figure: number; handle: HandleId } | null = null
    let bestScore = Infinity
    const p = new THREE.Vector3()
    this.figures.forEach((fig, fi) => {
      for (const id of HANDLES) {
        const s = this.project(fig.handlePosition(id, p))
        if (s.z > 1) continue
        const d = Math.hypot(s.x - x, s.y - y)
        if (d > PICK_RADIUS) continue
        const score = d + s.z * 4 + (fi === this.activeFigure ? 0 : 3)
        if (score < bestScore) {
          bestScore = score
          best = { figure: fi, handle: id }
        }
      }
    })
    return best
  }

  private ray(x: number, y: number): THREE.Ray {
    const rc = new THREE.Raycaster()
    rc.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera)
    return rc.ray
  }

  private onContextMenu = (e: Event) => e.preventDefault()

  private onPointerDown = (e: PointerEvent) => {
    if (this.tc.dragging || this.tc.axis) return
    const { x, y } = this.pointer(e)
    const el = this.renderer.domElement
    if (e.button === 0 && !e.shiftKey) {
      const hit = this.pick(x, y)
      if (hit) {
        const fig = this.figures[hit.figure]
        this.select({ figure: hit.figure, joint: handleJoint(hit.handle) })
        const pos = fig.handlePosition(hit.handle)
        const normal = this.camera.getWorldDirection(new THREE.Vector3())
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pos)
        const at = this.ray(x, y).intersectPlane(plane, new THREE.Vector3()) ?? pos.clone()
        const drag: Drag = { kind: 'handle', figure: hit.figure, handle: hit.handle, plane, offset: pos.clone().sub(at), moved: false }
        if (hit.handle === 'hips' && this.pinFeet) {
          drag.pins = (['l', 'r'] as const).map((side) => {
            const foot = fig.bones[`${side}Foot` as JointId]
            return { side, pos: foot.getWorldPosition(new THREE.Vector3()), quat: foot.getWorldQuaternion(new THREE.Quaternion()) }
          })
        }
        this.drag = drag
        // 拖拽控制点期间隐藏旋转环，避免遮挡
        this.tcHelper.visible = false
        el.setPointerCapture(e.pointerId)
        e.preventDefault()
        return
      }
    }
    this.drag = e.button === 0 && !e.shiftKey ? { kind: 'orbit', x, y, moved: false } : { kind: 'pan', x, y }
    el.setPointerCapture(e.pointerId)
  }

  private onPointerMove = (e: PointerEvent) => {
    const { x, y } = this.pointer(e)
    const d = this.drag
    if (!d) {
      if (this.tc.dragging) return
      const hit = this.tc.axis ? null : this.pick(x, y)
      if (hit?.figure !== this.hover?.figure || hit?.handle !== this.hover?.handle) {
        this.hover = hit
        this.renderer.domElement.style.cursor = hit ? 'grab' : ''
        this.syncHandles()
      }
      return
    }
    if (d.kind === 'orbit') {
      const dx = x - d.x
      const dy = y - d.y
      if (!d.moved && Math.hypot(dx, dy) < 3) return
      d.moved = true
      d.x = x
      d.y = y
      this.cam.yaw -= dx * 0.4
      this.cam.pitch += dy * 0.4
      this.applyCamera()
    } else if (d.kind === 'pan') {
      const scale = (2 * Math.tan((this.cam.fov * RAD) / 2) * this.cam.dist) / this.height
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
      const t = new THREE.Vector3(...this.cam.target)
        .addScaledVector(right, -(x - d.x) * scale)
        .addScaledVector(up, (y - d.y) * scale)
      d.x = x
      d.y = y
      this.cam.target = [t.x, t.y, t.z]
      this.applyCamera()
    } else {
      const hit = this.ray(x, y).intersectPlane(d.plane, new THREE.Vector3())
      if (!hit) return
      d.moved = true
      this.dragHandle(d, hit.add(d.offset))
      this.syncHandles()
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    const d = this.drag
    this.drag = null
    this.tcHelper.visible = this.selection !== null
    const el = this.renderer.domElement
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    if (!d) return
    if (d.kind === 'handle') {
      if (d.moved) this.commit()
      else this.invalidate()
    } else if (d.kind === 'orbit' && !d.moved) {
      this.select(null)
    }
  }

  private onPointerLeave = () => {
    if (this.hover && !this.drag) {
      this.hover = null
      this.renderer.domElement.style.cursor = ''
      this.syncHandles()
    }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.cam.dist *= Math.exp(e.deltaY * 0.0012)
    this.applyCamera()
  }

  private rotateWorld(bone: THREE.Object3D, delta: THREE.Quaternion) {
    const w = bone.getWorldQuaternion(new THREE.Quaternion())
    const pw = bone.parent!.getWorldQuaternion(new THREE.Quaternion())
    bone.quaternion.copy(pw.invert().multiply(delta.clone().multiply(w))).normalize()
    bone.updateMatrixWorld(true)
  }

  private setWorldQuaternion(bone: THREE.Object3D, q: THREE.Quaternion) {
    const pw = bone.parent!.getWorldQuaternion(new THREE.Quaternion())
    bone.quaternion.copy(pw.invert().multiply(q)).normalize()
    bone.updateMatrixWorld(true)
  }

  private aim(bone: THREE.Object3D, current: THREE.Vector3, target: THREE.Vector3) {
    const pivot = bone.getWorldPosition(new THREE.Vector3())
    const a = current.clone().sub(pivot)
    const b = target.clone().sub(pivot)
    if (a.lengthSq() < 1e-8 || b.lengthSq() < 1e-8) return
    this.rotateWorld(bone, new THREE.Quaternion().setFromUnitVectors(a.normalize(), b.normalize()))
  }

  private solveIk(fig: Mannequin, upperId: JointId, midId: JointId, endId: JointId, target: THREE.Vector3, endQuat?: THREE.Quaternion) {
    const upper = fig.bones[upperId]
    const mid = fig.bones[midId]
    const end = fig.bones[endId]
    const keep = endQuat ?? end.getWorldQuaternion(new THREE.Quaternion())
    const a = upper.getWorldPosition(new THREE.Vector3())
    const b = mid.getWorldPosition(new THREE.Vector3())
    const c = end.getWorldPosition(new THREE.Vector3())
    const l1 = a.distanceTo(b)
    const l2 = b.distanceTo(c)
    const dist = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(l1 + l2 - 1e-4, a.distanceTo(target)))
    const want = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - dist * dist) / (2 * l1 * l2))))
    const ba = a.clone().sub(b)
    const bc = c.clone().sub(b)
    const now = ba.angleTo(bc)
    let axis = ba.clone().cross(bc)
    if (axis.lengthSq() < 1e-7) {
      axis = FLEX_AXIS[midId]!.clone().applyQuaternion(mid.getWorldQuaternion(new THREE.Quaternion())).negate()
    }
    axis.normalize()
    this.rotateWorld(mid, new THREE.Quaternion().setFromAxisAngle(axis, want - now))
    end.getWorldPosition(c)
    this.aim(upper, c, target)
    this.setWorldQuaternion(end, keep)
  }

  private dragHandle(d: Extract<Drag, { kind: 'handle' }>, target: THREE.Vector3) {
    const fig = this.figures[d.figure]
    const id = d.handle
    if (id === 'hips') {
      fig.bones.hips.position.copy(target)
      fig.root.updateMatrixWorld(true)
      for (const pin of d.pins ?? []) {
        this.solveIk(fig, `${pin.side}Thigh` as JointId, `${pin.side}Shin` as JointId, `${pin.side}Foot` as JointId, pin.pos, pin.quat)
      }
      return
    }
    const chain = IK_CHAIN[id]
    if (chain) {
      this.solveIk(fig, chain[0], chain[1], id as JointId, target)
      return
    }
    const parent = AIM_PARENT[id]
    if (parent) this.aim(fig.bones[parent], fig.handlePosition(id), target)
  }

  // ---------- OpenPose 骨架图 ----------

  private openPosePoints(fig: Mannequin): THREE.Vector3[] {
    const b = fig.bones
    const w = (id: JointId) => b[id].getWorldPosition(new THREE.Vector3())
    const h = (x: number, y: number, z: number) => b.head.localToWorld(new THREE.Vector3(x, y, z))
    const lSh = w('lUpperArm')
    const rSh = w('rUpperArm')
    return [
      h(0, 0.085, 0.13),
      lSh.clone().add(rSh).multiplyScalar(0.5),
      rSh, w('rForearm'), w('rHand'),
      lSh, w('lForearm'), w('lHand'),
      w('rThigh'), w('rShin'), w('rFoot'),
      w('lThigh'), w('lShin'), w('lFoot'),
      h(-0.036, 0.12, 0.1), h(0.036, 0.12, 0.1),
      h(-0.095, 0.1, 0.01), h(0.095, 0.1, 0.01),
    ]
  }

  private drawOpenPose(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const LIMBS = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]]
    const COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]]
    const stick = Math.max(2, h / 128)
    this.scene.updateMatrixWorld(true)
    for (const fig of this.figures) {
      const pts = this.openPosePoints(fig).map((p) => {
        const v = p.project(this.camera)
        return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h }
      })
      ctx.globalAlpha = 0.6
      LIMBS.forEach(([a, b], i) => {
        const p = pts[a]
        const q = pts[b]
        const len = Math.hypot(q.x - p.x, q.y - p.y)
        ctx.save()
        ctx.translate((p.x + q.x) / 2, (p.y + q.y) / 2)
        ctx.rotate(Math.atan2(q.y - p.y, q.x - p.x))
        ctx.beginPath()
        ctx.ellipse(0, 0, len / 2, stick, 0, 0, Math.PI * 2)
        ctx.fillStyle = `rgb(${COLORS[i].join(',')})`
        ctx.fill()
        ctx.restore()
      })
      ctx.globalAlpha = 1
      pts.forEach((p, i) => {
        ctx.beginPath()
        ctx.arc(p.x, p.y, stick, 0, Math.PI * 2)
        ctx.fillStyle = `rgb(${COLORS[i].join(',')})`
        ctx.fill()
      })
    }
  }

  // ---------- 出图 ----------

  /** 按当前视角与样式渲染一张参考图，返回 PNG 的 data URL */
  exportImage(height = 1200): string {
    const aspect = this.width / this.height
    const w = Math.round(height * aspect)
    const out = document.createElement('canvas')
    out.width = w
    out.height = height
    const ctx = out.getContext('2d')!
    if (this.style === 'openpose') {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, w, height)
      this.camera.updateMatrixWorld(true)
      this.drawOpenPose(ctx, w, height)
      return out.toDataURL('image/png')
    }
    const ratio = this.renderer.getPixelRatio()
    const grid = this.grid.visible
    this.grid.visible = false
    this.handleGroup.visible = false
    this.tcHelper.visible = false
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(w, height, false)
    try {
      if (this.style === 'depth') this.updateDepthRange()
      if (this.style === 'line') this.renderLineArt(w, height, false)
      else this.renderer.render(this.scene, this.camera)
      ctx.drawImage(this.renderer.domElement, 0, 0)
    } finally {
      this.grid.visible = grid
      this.handleGroup.visible = true
      this.tcHelper.visible = this.selection !== null
      this.renderer.setPixelRatio(ratio)
      this.renderer.setSize(this.width, this.height, false)
      this.render()
    }
    return out.toDataURL('image/png')
  }
}

export function viewLabel(cam: Pick<CameraState, 'yaw' | 'pitch'>): string {
  const a = Math.abs(cam.yaw)
  const side = a < 20 ? '正面' : a < 70 ? '斜侧' : a < 110 ? '侧面' : a < 160 ? '斜后' : '背面'
  const tilt = cam.pitch > 60 ? '顶视' : cam.pitch > 18 ? '俯视' : cam.pitch < -60 ? '底视' : cam.pitch < -18 ? '仰视' : ''
  return tilt ? `${side}·${tilt}` : side
}
