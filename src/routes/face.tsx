import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CopyIcon, DownloadIcon, RotateCcwIcon, SearchIcon, PlusIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { faceQuery } from '@/api/gallery'
import { countFaceCatalog, countVisibleFaceEntries, visibleFaceSections } from '@/lib/faceCatalog'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/notifications'
import { cn } from '@/lib/utils'
import { useStudio } from '@/store/studioStore'
import type { FaceCategory, FaceEntry, FaceExample } from '@/types/gallery'

export const Route = createFileRoute('/face')({
  staticData: { title: '人物表情库' },
  loader: ({ context }) => context.queryClient.ensureQueryData(faceQuery),
  pendingComponent: () => <Skeleton className="h-[540px] rounded-[22px]" />,
  component: FacePage,
})

function groupEntries(entries: FaceEntry[]) {
  const groups: { 名称: string; items: FaceEntry[] }[] = []
  for (const entry of entries) {
    const last = groups[groups.length - 1]
    if (last && last.名称 === entry.分组) last.items.push(entry)
    else groups.push({ 名称: entry.分组, items: [entry] })
  }
  return groups
}

async function copyText(text: string, message: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(message)
  } catch {
    toast.error('复制失败，请手动选择文本')
  }
}

function FacePage() {
  const { data } = useSuspenseQuery(faceQuery)
  const { addFaceTags } = useStudio()
  const [section, setSection] = useState('')
  const [query, setQuery] = useState('')
  const [viewer, setViewer] = useState<{ example: FaceExample; title: string; addToRecipe: () => void } | null>(null)

  const counts = useMemo(() => countFaceCatalog(data), [data])
  const visibleSections = useMemo(() => visibleFaceSections(data, section, query), [data, section, query])
  const visibleEntries = countVisibleFaceEntries(visibleSections)
  const searchedSections = useMemo(() => visibleFaceSections(data, '', query), [data, query])
  const searchedEntries = countVisibleFaceEntries(searchedSections)
  const visibleBySection = useMemo(
    () => new Map(searchedSections.map((item) => [item.名称, countVisibleFaceEntries([item])])),
    [searchedSections],
  )
  const filtering = Boolean(section || query.trim())
  const q = query.trim()

  return (
    <>
      <PageHeader
        title="人物表情库"
        description={`词库 ${counts.entries.toLocaleString('zh-CN')} 条可浏览词条（${counts.uniquePrompts.toLocaleString('zh-CN')} 个不重复提示词）· ${counts.examples.toLocaleString('zh-CN')} 张例图 · 微笑/愤怒/悲伤/惊讶/恐惧/厌恶/羞涩/无表情/困惑/专注/自信`}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSection('')
              setQuery('')
            }}
          >
            <RotateCcwIcon className="size-3.5" />
            重置
          </Button>
        }
      />

      {/* 体系切换 */}
      <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:pb-0">
        <button
          type="button"
          onClick={() => setSection('')}
          className={cn(
            'shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
            section === '' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
          )}
        >
          全部 ({q ? `${searchedEntries}/${counts.entries}` : counts.entries})
        </button>
        {counts.sections.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => setSection(s.name)}
            aria-label={`${s.name}，词库 ${s.entries} 条`}
            className={cn(
              'shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
              section === s.name ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
            )}
          >
            {s.name} ({q ? `${visibleBySection.get(s.name) ?? 0}/${s.entries}` : s.entries})
          </button>
        ))}
      </div>

      {/* 搜索 */}
      <div className="grid gap-3 rounded-[22px] bg-muted p-4 @xl/main:grid-cols-[minmax(0,1fr)_auto]">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索提示词或中文含义，如 smile / angry / crying / surprised…"
            className="bg-background pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>词库 {counts.entries.toLocaleString('zh-CN')} 条</span>
          {filtering && <span>当前显示 {visibleEntries.toLocaleString('zh-CN')} 条</span>}
        </div>
      </div>

      {visibleEntries === 0 ? (
        <EmptyState title="没有找到匹配的表情提示词" description="换个关键词，或清空搜索再看全部内容" />
      ) : (
        <div className="flex flex-col gap-6">
          {visibleSections.map((s) => (
            <section key={s.名称} className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-muted-foreground sm:text-base">{s.名称}</h2>
              <div className="grid gap-4 xl:grid-cols-2">
                {s.分类.map((c) => (
                  <FaceCard
                    key={c.id}
                    category={c}
                    systemName={s.名称}
                    onOpen={(example) => setViewer({ example, title: c.名称, addToRecipe: () => addFaceTags([example.提示词]) })}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <Dialog open={Boolean(viewer)} onOpenChange={(o) => !o && setViewer(null)}>
        <DialogContent className="max-h-[92dvh] w-[95vw] max-w-3xl overflow-y-auto p-0 sm:max-w-3xl">
          {viewer && (
            <div className="grid md:grid-cols-[minmax(0,1fr)_300px]">
              <div className="flex items-center justify-center bg-muted/60 p-3">
                <img
                  src={`/${viewer.example.原图}`}
                  alt={`${viewer.title} 例图`}
                  className="max-h-[62dvh] w-auto rounded-xl object-contain"
                />
              </div>
              <div className="flex flex-col gap-4 border-t p-5 md:border-t-0 md:border-l">
                <DialogHeader>
                  <DialogTitle className="text-base">{viewer.title} · 例图</DialogTitle>
                </DialogHeader>
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">生成提示词</div>
                  <p className="rounded-xl bg-muted p-3 font-mono text-[11px] leading-relaxed break-words">
                    {viewer.example.提示词}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void copyText(viewer.example.提示词, '已复制完整提示词')}
                  >
                    <CopyIcon className="size-3.5" />
                    复制提示词
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={viewer.addToRecipe}
                  >
                    <PlusIcon className="size-3.5" />
                    加入配方
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/${viewer.example.原图}`} download>
                      <DownloadIcon className="size-3.5" />
                      下载原图
                    </a>
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function FaceCard({ category, onOpen, systemName }: { category: FaceCategory; onOpen: (example: FaceExample) => void; systemName: string }) {
  const groups = groupEntries(category.词条)
  const { addFaceTags } = useStudio()
  const isPracticalRecipe = systemName === '实战配方'
  
  const copyAll = () => void copyText(category.词条.map((e) => e.提示词).join(', '), `已复制「${category.名称}」全部提示词`)
  const addAllToRecipe = () => {
    const tags = category.词条.map((e) => e.提示词)
    addFaceTags(tags)
  }
  const addGroupToRecipe = (items: FaceEntry[]) => {
    const tags = items.map((e) => e.提示词)
    addFaceTags(tags)
  }
  const addSingleToRecipe = (entry: FaceEntry) => {
    addFaceTags([entry.提示词])
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-[20px] bg-muted">
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold sm:text-base">
            {category.名称}
            <Badge variant="secondary" className="shrink-0 font-normal">
              {category.词条.length}
            </Badge>
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{category.简介}</p>
        </div>
        {isPracticalRecipe && (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="ghost" size="sm" onClick={copyAll} className="shrink-0">
              <CopyIcon className="size-3.5" />
              全部复制
            </Button>
            <Button variant="outline" size="sm" onClick={addAllToRecipe} className="shrink-0">
              <PlusIcon className="size-3.5" />
              全部加入配方
            </Button>
          </div>
        )}
      </div>

      {category.示例.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-4 py-3">
          {category.示例.map((example, i) => (
            <button
              key={example.原图}
              type="button"
              onClick={() => onOpen(example)}
              className="group relative shrink-0 cursor-zoom-in overflow-hidden rounded-xl bg-background"
              title={example.提示词}
            >
              <img
                src={`/${example.缩略图}`}
                alt={`${category.名称} 例图 ${i + 1}`}
                loading="lazy"
                className="h-28 w-[84px] object-cover object-top transition group-hover:scale-105"
              />
            </button>
          ))}
        </div>
      )}

      <div className="mx-3 mb-3 overflow-hidden rounded-2xl bg-background">
        {groups.map((group) => (
          <div key={`${category.id}-${group.名称}`} className="border-b last:border-b-0">
            <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5">
              <span className="text-[11px] font-semibold text-muted-foreground">{group.名称}</span>
              <div className="flex items-center gap-1 ml-auto">
                <button
                  type="button"
                  onClick={() =>
                    void copyText(group.items.map((e) => e.提示词).join(', '), `已复制「${group.名称}」提示词`)
                  }
                  className="shrink-0 text-muted-foreground transition hover:text-foreground"
                  aria-label={`复制${group.名称}提示词`}
                >
                  <CopyIcon className="size-3" />
                </button>
                {isPracticalRecipe && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px] shrink-0"
                    onClick={() => addGroupToRecipe(group.items)}
                  >
                    <PlusIcon className="size-3" />
                    加入配方
                  </Button>
                )}
              </div>
            </div>
            {group.items.map((entry) => (
              <div
                key={`${category.id}-${entry.提示词}`}
                className="flex items-center gap-2 px-3 py-1.5 transition hover:bg-muted/40"
              >
                <code className="min-w-0 flex-1 font-mono text-[11px] break-words text-foreground/90 sm:text-xs">
                  {entry.提示词}
                </code>
                <span className="w-28 shrink-0 truncate text-right text-[11px] text-muted-foreground sm:w-40 sm:text-xs">
                  {entry.中文}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => void copyText(entry.提示词, `已复制：${entry.中文}`)}
                    className="shrink-0 text-muted-foreground transition hover:text-foreground"
                    aria-label={`复制 ${entry.提示词}`}
                  >
                    <CopyIcon className="size-3" />
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px] shrink-0"
                    onClick={() => addSingleToRecipe(entry)}
                  >
                    <PlusIcon className="size-3" />
                    加入
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}