import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  DownloadIcon,
  FlipHorizontal2Icon,
  FocusIcon,
  FootprintsIcon,
  LoaderCircleIcon,
  PlusIcon,
  Redo2Icon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  Undo2Icon,
  UserPlusIcon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { posesQuery } from '@/api/gallery'
import { PageHeader } from '@/components/common/PageHeader'
import { ViewBall } from '@/components/pose3d/ViewBall'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/lib/notifications'
import { importGalleryPose } from '@/lib/pose3d/importPose'
import { JOINT_LABELS, PRESETS, type BodyType } from '@/lib/pose3d/rig'
import {
  DEFAULT_CAMERA,
  MAX_FIGURES,
  PoseStage,
  viewLabel,
  type CameraState,
  type OutputStyle,
  type SceneState,
  type Selection,
} from '@/lib/pose3d/stage'
import { poseImagePath, referenceImageUrl } from '@/lib/recipeImages'
import { cn } from '@/lib/utils'
import { useStudio } from '@/store/studioStore'
import type { PoseItem } from '@/types/gallery'

export const Route = createFileRoute('/pose-generator')({
  staticData: { title: '3D 姿势生成器' },
  validateSearch: (search: Record<string, unknown>): { pose?: string } =>
    typeof search.pose === 'string' && search.pose ? { pose: search.pose } : {},
  component: PoseGeneratorPage,
})

const DRAFT_KEY = 'pose_generator_draft_v1'

const STYLES: { id: OutputStyle; label: string; hint: string }[] = [
  { id: 'line', label: '线稿白模', hint: '与图库素体一致的白底线稿' },
  { id: 'shaded', label: '灰模', hint: '带明暗的立体素体' },
  { id: 'depth', label: '深度图', hint: '近白远黑，适合 Depth ControlNet' },
  { id: 'openpose', label: 'OpenPose', hint: '彩色骨架图，适合 OpenPose ControlNet' },
]

const ASPECTS = [
  { id: '3:4', ratio: 3 / 4 },
  { id: '1:1', ratio: 1 },
  { id: '4:3', ratio: 4 / 3 },
  { id: '9:16', ratio: 9 / 16 },
  { id: '16:9', ratio: 16 / 9 },
] as const

type AspectId = (typeof ASPECTS)[number]['id']

const VIEW_PRESETS: { label: string; yaw: number; pitch: number }[] = [
  { label: '正面', yaw: 0, pitch: 4 },
  { label: '斜侧', yaw: -42, pitch: 4 },
  { label: '侧面', yaw: -90, pitch: 4 },
  { label: '背面', yaw: 180, pitch: 4 },
  { label: '俯视', yaw: 0, pitch: 38 },
  { label: '仰视', yaw: 0, pitch: -30 },
]

interface Reference {
  id: string
  name: string
  angle: string
  image: string
}

interface Draft {
  state: SceneState
  style: OutputStyle
  aspect: AspectId
  reference: Reference | null
}

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Draft
    return d?.state?.figures?.length ? d : null
  } catch {
    return null
  }
}

function Panel({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[20px] bg-muted p-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {extra}
      </div>
      <div className="grid gap-2.5">{children}</div>
    </section>
  )
}

function Slider({ label, value, min, max, step = 1, unit = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="grid grid-cols-[3.2rem_1fr_3.4rem] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-5 w-full min-w-0 accent-primary"
      />
      <span className="text-right font-mono tabular-nums">
        {step < 1 ? value.toFixed(1) : Math.round(value)}
        {unit}
      </span>
    </label>
  )
}

function Chip({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'rounded-lg px-2.5 py-1.5 text-xs font-medium transition',
        active ? 'bg-primary text-primary-foreground shadow-xs' : 'bg-background text-foreground/80 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function PoseGeneratorPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const qc = useQueryClient()
  const { setPose } = useStudio()

  const hostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<PoseStage | null>(null)
  const [draft] = useState(readDraft)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState('')
  const [camera, setCamera] = useState<CameraState>(draft?.state.camera ?? DEFAULT_CAMERA)
  const [style, setStyle] = useState<OutputStyle>(draft?.style ?? 'line')
  const [aspect, setAspect] = useState<AspectId>(draft?.aspect ?? '3:4')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [history, setHistory] = useState({ undo: false, redo: false })
  const [figureCount, setFigureCount] = useState(1)
  const [activeFigure, setActiveFigure] = useState(0)
  const [body, setBody] = useState<BodyType>('female')
  const [pinFeet, setPinFeet] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showHandles, setShowHandles] = useState(true)
  const [reference, setReference] = useState<Reference | null>(draft?.reference ?? null)
  const [overlay, setOverlay] = useState(0)
  // 地址里带着 ?pose= 就表示正在导入，导入结束后会清掉这个参数
  const importing = Boolean(search.pose)

  // 存草稿时要用的最新界面选项（由各个修改入口同步写入）
  const live = useRef({ style, aspect, reference })

  const saveDraft = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    try {
      const d: Draft = { state: stage.getState(), ...live.current }
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d))
    } catch {
      // 存储不可用时忽略
    }
  }, [])

  const syncFigures = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    setFigureCount(stage.figureCount)
    setActiveFigure(stage.activeFigure)
    setBody(stage.getBody())
  }, [])

  // 创建 3D 舞台
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let stage: PoseStage
    let timer = 0
    try {
      stage = new PoseStage(host, {
        onCommit: () => {
          syncFigures()
          saveDraft()
        },
        onCamera: (c) => {
          setCamera(c)
          window.clearTimeout(timer)
          timer = window.setTimeout(saveDraft, 400)
        },
        onSelect: (s) => {
          setSelection(s)
          syncFigures()
        },
        onHistory: (undo, redo) => setHistory({ undo, redo }),
        onReady: () => setReady(true),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '无法初始化 3D 画面'
      queueMicrotask(() => setFailed(message))
      return
    }
    stageRef.current = stage
    const d = readDraft()
    if (d) stage.setState(d.state)
    stage.setStyle(live.current.style)
    syncFigures()
    return () => {
      window.clearTimeout(timer)
      stageRef.current = null
      setReady(false)
      stage.dispose()
    }
  }, [saveDraft, syncFigures])

  // 从图库导入姿势（/pose-generator?pose=<id>）
  useEffect(() => {
    const id = search.pose
    if (!ready || !id) return
    let cancelled = false
    void (async () => {
      try {
        const { items } = await qc.ensureQueryData(posesQuery)
        const item: PoseItem | undefined = items.find((x) => x.id === id)
        if (!item) throw new Error('没有找到这个姿势')
        const ref: Reference = { id: item.id, name: item.姿势名称, angle: item.角度, image: referenceImageUrl(poseImagePath(item, false)) }
        const imported = await importGalleryPose(item)
        if (cancelled) return
        const stage = stageRef.current
        if (!stage) return
        setReference(ref)
        live.current.reference = ref
        if (imported) {
          stage.setState({ figures: imported.figures, camera: { ...DEFAULT_CAMERA, yaw: imported.view.yaw, pitch: imported.view.pitch } })
          stage.ground(true)
          stage.frame()
          stage.resetHistory()
          if (imported.figures.length > 1) {
            // 双人肢体交缠时自动估算误差较大，叠上原图方便对照修正
            setOverlay(0.3)
            toast.info(`已导入「${item.姿势名称}」。双人姿势的自动估算偏差较大，已叠加原图，请对照调整`)
          } else {
            setOverlay(0)
            toast.success(`已导入「${item.姿势名称}」，可以直接微调`)
          }
        } else {
          setOverlay(0.35)
          toast.info('这张图暂时没有可用的 3D 数据，已把原图叠在画面上，可对照着手动摆姿势')
        }
        syncFigures()
        saveDraft()
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : '导入姿势失败')
      } finally {
        if (!cancelled) void navigate({ search: {}, replace: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ready, search.pose, qc, navigate, saveDraft, syncFigures])

  // 快捷键：撤销 / 重做 / 取消选择
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const stage = stageRef.current
      if (!stage) return
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && (target as HTMLInputElement).type !== 'range') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) stage.redo()
        else stage.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        stage.redo()
      } else if (e.key === 'Escape') {
        stage.select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const stage = () => stageRef.current
  const ratio = ASPECTS.find((a) => a.id === aspect)!.ratio

  const changeStyle = (s: OutputStyle) => {
    setStyle(s)
    live.current.style = s
    stage()?.setStyle(s)
    saveDraft()
  }

  const changeAspect = (a: AspectId) => {
    setAspect(a)
    live.current.aspect = a
    saveDraft()
  }

  const render = (): string | null => {
    try {
      return stage()?.exportImage(1200) ?? null
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成图片失败')
      return null
    }
  }

  const poseName = reference ? `${reference.name}（微调）` : '自定义 3D 姿势'

  const handleDownload = () => {
    const url = render()
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `pose-${style}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`
    a.click()
    toast.success('已生成并下载参考图')
  }

  const handleAddToRecipe = () => {
    const url = render()
    if (!url) return
    const item: PoseItem = {
      id: crypto.randomUUID(),
      source: 'upload',
      体系: '自定义',
      姿势编号: '',
      分类: '3D 生成',
      姿势名称: poseName,
      角度: viewLabel(camera),
      缩略图: url,
      原图: url,
      检索: poseName,
    }
    setPose(item)
    toast.success('已把这张姿势图加入角色配方')
  }

  const handleNew = () => {
    const s = stage()
    if (!s) return
    s.setState({ figures: [structuredClone(PRESETS[0].pose)], camera: DEFAULT_CAMERA })
    setReference(null)
    live.current.reference = null
    setOverlay(0)
    syncFigures()
    saveDraft()
  }

  const clearReference = () => {
    setReference(null)
    live.current.reference = null
    setOverlay(0)
    saveDraft()
  }

  return (
    <>
      <PageHeader
        title="3D 姿势生成器"
        description="拖动关节摆出任意姿势，用视角球选好机位，一键生成姿势参考图"
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!history.undo} onClick={() => stage()?.undo()} aria-label="撤销">
              <Undo2Icon className="size-3.5" />
              撤销
            </Button>
            <Button variant="outline" size="sm" disabled={!history.redo} onClick={() => stage()?.redo()} aria-label="重做">
              <Redo2Icon className="size-3.5" />
              重做
            </Button>
            <Button variant="outline" size="sm" onClick={handleNew}>
              <RotateCcwIcon className="size-3.5" />
              新建
            </Button>
          </>
        }
      />

      <div className="grid min-w-0 gap-4 @4xl/main:grid-cols-[minmax(0,1fr)_340px]">
        {/* 画面 */}
        <div className="min-w-0">
          <div className="flex justify-center rounded-[22px] bg-muted p-2.5 sm:p-3">
            <div
              className="relative overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-border/60"
              style={{ aspectRatio: String(ratio), width: `min(100%, calc(min(76dvh, 880px) * ${ratio}))` }}
            >
              <div ref={hostRef} className="absolute inset-0" data-testid="pose-stage" />
              {reference && overlay > 0 && (
                <img
                  src={reference.image}
                  alt=""
                  className="pointer-events-none absolute inset-0 h-full w-full object-contain mix-blend-multiply"
                  style={{ opacity: overlay }}
                />
              )}
              {(importing || !ready) && !failed && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 bg-white/70 text-sm text-zinc-700">
                  <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
                  {importing ? '正在导入姿势…' : '正在准备 3D 画面…'}
                </div>
              )}
              {failed && (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-zinc-700">
                  当前浏览器无法显示 3D 画面（需要 WebGL）：{failed}
                </div>
              )}
              <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5">
                <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">{viewLabel(camera)}</span>
                {selection && (
                  <span className="rounded-md bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {figureCount > 1 ? `人物 ${selection.figure + 1} · ` : ''}
                    {JOINT_LABELS[selection.joint]}
                  </span>
                )}
              </div>
            </div>
          </div>
          <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
            <b className="font-medium text-foreground/80">拖动圆点</b>摆动关节（手腕、脚踝会带动整条手臂或腿；髋部圆点移动整个人）；
            <b className="font-medium text-foreground/80">点一下圆点</b>会出现彩色旋转环，可绕单个轴精确旋转（含扭转）。
            空白处拖动旋转视角，滚轮缩放，右键或 Shift 拖动平移。蓝色为人物左侧，红色为右侧。
          </p>
        </div>

        {/* 控制面板 */}
        <div className="grid min-w-0 content-start gap-3">
          {reference && (
            <Panel
              title="参考原图"
              extra={
                <button type="button" onClick={clearReference} aria-label="移除参考原图" className="text-muted-foreground hover:text-foreground">
                  <XIcon className="size-4" />
                </button>
              }
            >
              <div className="flex gap-3">
                <img src={reference.image} alt={reference.name} className="h-28 w-21 shrink-0 rounded-lg bg-white object-contain ring-1 ring-border/60" />
                <div className="grid min-w-0 flex-1 content-start gap-1.5">
                  <div className="line-clamp-2 text-xs font-semibold">{reference.name}</div>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="outline">{reference.angle || '参考'}</Badge>
                  </div>
                  <p className="text-[11px] leading-snug text-muted-foreground">3D 姿势由原图自动估算，可能有偏差，对照原图微调即可。</p>
                </div>
              </div>
              <Slider label="叠加原图" value={Math.round(overlay * 100)} min={0} max={80} unit="%" onChange={(v) => setOverlay(v / 100)} />
            </Panel>
          )}

          <Panel
            title="视角"
            extra={
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => stage()?.frame()}>
                <FocusIcon className="size-3.5" />
                全身入镜
              </Button>
            }
          >
            <div className="flex items-center gap-3">
              <ViewBall yaw={camera.yaw} pitch={camera.pitch} onChange={(v) => stage()?.setCamera(v)} />
              <div className="grid flex-1 grid-cols-2 gap-1.5">
                {VIEW_PRESETS.map((p) => (
                  <Chip
                    key={p.label}
                    active={Math.abs(camera.yaw - p.yaw) < 1 && Math.abs(camera.pitch - p.pitch) < 1}
                    onClick={() => stage()?.setCamera({ yaw: p.yaw, pitch: p.pitch })}
                  >
                    {p.label}
                  </Chip>
                ))}
              </div>
            </div>
            <Slider label="水平角" value={camera.yaw} min={-180} max={180} unit="°" onChange={(v) => stage()?.setCamera({ yaw: v })} />
            <Slider label="俯仰角" value={camera.pitch} min={-89} max={89} unit="°" onChange={(v) => stage()?.setCamera({ pitch: v })} />
            <Slider label="远近" value={camera.dist} min={0.8} max={12} step={0.1} unit="m" onChange={(v) => stage()?.setCamera({ dist: v })} />
            <Slider label="透视" value={camera.fov} min={10} max={80} unit="°" onChange={(v) => stage()?.setCamera({ fov: v })} />
          </Panel>

          <Panel
            title="姿势"
            extra={
              selection ? (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => stage()?.resetSelectedJoint()}>
                  <RotateCcwIcon className="size-3.5" />
                  复位{JOINT_LABELS[selection.joint]}
                </Button>
              ) : undefined
            }
          >
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <Chip key={p.id} onClick={() => stage()?.applyPose(p.pose)} title={`套用预设：${p.name}`}>
                  {p.name}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button variant="outline" size="sm" className="h-8 bg-background text-xs" onClick={() => stage()?.mirror()}>
                <FlipHorizontal2Icon className="size-3.5" />
                左右镜像
              </Button>
              <Button variant="outline" size="sm" className="h-8 bg-background text-xs" onClick={() => stage()?.groundAndCommit()}>
                <FootprintsIcon className="size-3.5" />
                落到地面
              </Button>
              <div className="inline-flex items-center rounded-lg bg-background p-0.5">
                {(['female', 'male'] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => {
                      stage()?.setBody(b)
                      setBody(b)
                    }}
                    className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition', body === b ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                  >
                    {b === 'female' ? '女体' : '男体'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {figureCount > 1 &&
                Array.from({ length: figureCount }, (_, i) => (
                  <Chip
                    key={i}
                    active={activeFigure === i}
                    onClick={() => {
                      stage()?.setActiveFigure(i)
                      syncFigures()
                    }}
                  >
                    人物 {i + 1}
                  </Chip>
                ))}
              {figureCount < MAX_FIGURES && (
                <Button variant="outline" size="sm" className="h-8 bg-background text-xs" onClick={() => stage()?.addFigure()}>
                  <UserPlusIcon className="size-3.5" />
                  添加第二个人物
                </Button>
              )}
              {figureCount > 1 && (
                <Button variant="outline" size="sm" className="h-8 bg-background text-xs" onClick={() => stage()?.removeFigure()}>
                  <Trash2Icon className="size-3.5" />
                  删除当前人物
                </Button>
              )}
            </div>
            <div className="grid gap-2 pt-0.5 text-xs">
              <label className="flex items-center justify-between gap-2">
                <span>移动髋部时双脚固定在原地</span>
                <Switch
                  size="sm"
                  checked={pinFeet}
                  onCheckedChange={(v) => {
                    setPinFeet(v)
                    if (stageRef.current) stageRef.current.pinFeet = v
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span>显示关节圆点</span>
                <Switch
                  size="sm"
                  checked={showHandles}
                  onCheckedChange={(v) => {
                    setShowHandles(v)
                    stage()?.setHandlesVisible(v)
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span>显示地面网格（不会出现在成图里）</span>
                <Switch
                  size="sm"
                  checked={showGrid}
                  onCheckedChange={(v) => {
                    setShowGrid(v)
                    stage()?.setGridVisible(v)
                  }}
                />
              </label>
            </div>
          </Panel>

          <Panel title="生成参考图">
            <div className="grid grid-cols-2 gap-1.5">
              {STYLES.map((s) => (
                <Chip key={s.id} active={style === s.id} onClick={() => changeStyle(s.id)} title={s.hint}>
                  {s.label}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">画幅</span>
              {ASPECTS.map((a) => (
                <Chip key={a.id} active={aspect === a.id} onClick={() => changeAspect(a.id)}>
                  {a.id}
                </Chip>
              ))}
            </div>
            <Button onClick={handleAddToRecipe} disabled={!ready}>
              <PlusIcon className="size-4" />
              生成并加入角色配方
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="bg-background" onClick={handleDownload} disabled={!ready}>
                <DownloadIcon className="size-4" />
                下载 PNG
              </Button>
              <Button variant="outline" className="bg-background" asChild>
                <Link to="/studio">
                  <SparklesIcon className="size-4" />
                  去合成台
                </Link>
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              成图高 1200 像素，画面即所得（圆点、旋转环和网格不会出现在图里）。
            </p>
          </Panel>
        </div>
      </div>
    </>
  )
}
