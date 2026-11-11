import type { FaceCategory, FaceData, FaceEntry } from '@/types/gallery'

/**
 * 人物表情库的计数口径：
 * - entries：可浏览词条行。每个分类里的每一条「提示词 + 中文」都算 1 条，也是页面上能逐条复制、加入配方的行数。
 * - uniquePrompts：不重复的英文提示词。同一提示词出现在多个分类时，词条数大于不重复提示词数。
 * - examples：例图位。同一张图被两个分类引用时按两个可点开的例图位计数。
 * 筛选只影响「当前显示」，不改写词库总数。
 */
export interface FaceCatalogCounts {
  entries: number
  uniquePrompts: number
  examples: number
  categories: number
  sections: { name: string; entries: number }[]
}

export interface VisibleFaceCategory extends FaceCategory {
  词条: FaceEntry[]
}

export interface VisibleFaceSection {
  名称: string
  分类: VisibleFaceCategory[]
}

export function countFaceCatalog(data: FaceData): FaceCatalogCounts {
  const prompts = new Set<string>()
  let entries = 0
  let examples = 0
  let categories = 0
  const sections = data.体系.map((section) => {
    let sectionEntries = 0
    for (const category of section.分类) {
      categories += 1
      examples += category.示例.length
      sectionEntries += category.词条.length
      for (const entry of category.词条) prompts.add(entry.提示词)
    }
    entries += sectionEntries
    return { name: section.名称, entries: sectionEntries }
  })
  return { entries, uniquePrompts: prompts.size, examples, categories, sections }
}

export function entryMatchesFaceQuery(sectionName: string, category: FaceCategory, entry: FaceEntry, query: string): boolean {
  if (!query) return true
  return `${sectionName} ${category.名称} ${category.简介} ${entry.分组} ${entry.提示词} ${entry.中文}`.toLowerCase().includes(query)
}

/** 返回当前体系与搜索条件下实际渲染的词条。分类名或简介命中时，该分类的词条一并计入，避免出现空卡片和数量不符。 */
export function visibleFaceSections(data: FaceData, section: string, query: string): VisibleFaceSection[] {
  const q = query.trim().toLowerCase()
  return data.体系
    .filter((item) => !section || item.名称 === section)
    .map((item) => ({
      名称: item.名称,
      分类: item.分类
        .map((category) => ({
          ...category,
          词条: category.词条.filter((entry) => entryMatchesFaceQuery(item.名称, category, entry, q)),
        }))
        .filter((category) => category.词条.length > 0),
    }))
    .filter((item) => item.分类.length > 0)
}

export function countVisibleFaceEntries(sections: readonly VisibleFaceSection[]): number {
  return sections.reduce((total, section) => total + section.分类.reduce((sum, category) => sum + category.词条.length, 0), 0)
}
