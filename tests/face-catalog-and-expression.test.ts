import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { countFaceCatalog, countVisibleFaceEntries, visibleFaceSections } from '../src/lib/faceCatalog.ts'
import { applyRecipeTagPrompt, recipeTagLines } from '../src/lib/recipePrompt.ts'
import { addTags, removeTag } from '../src/lib/recipeTags.ts'
import type { FaceData, RecipeState } from '../src/types/gallery.ts'

const face = JSON.parse(readFileSync(new URL('../data/face-zh.json', import.meta.url), 'utf8')) as FaceData

function recipe(patch: Partial<RecipeState> = {}): RecipeState {
  return { portrait: null, costume: null, pose: null, bodyTags: [], faceTags: [], ...patch }
}

test('表情词库按可浏览词条计数，重复提示词不合并', () => {
  let rows = 0
  let examples = 0
  const unique = new Set<string>()
  for (const section of face.体系) {
    for (const category of section.分类) {
      examples += category.示例.length
      for (const entry of category.词条) {
        rows += 1
        unique.add(entry.提示词)
      }
    }
  }
  const counts = countFaceCatalog(face)
  assert.equal(counts.entries, rows)
  assert.equal(counts.examples, examples)
  assert.equal(counts.uniquePrompts, unique.size)
  assert.equal(counts.entries, 328)
  assert.equal(counts.uniquePrompts, 280)
  assert.equal(counts.examples, 247)
  assert.ok(counts.entries > counts.uniquePrompts)
  assert.equal(counts.sections.reduce((sum, section) => sum + section.entries, 0), counts.entries)
  const unfiltered = visibleFaceSections(face, '', '')
  assert.equal(countVisibleFaceEntries(unfiltered), counts.entries)
})

test('体系与搜索筛选只改变当前显示，不改变词库总数', () => {
  const counts = countFaceCatalog(face)
  const section = counts.sections[0]
  const sectionView = visibleFaceSections(face, section.name, '')
  assert.equal(countVisibleFaceEntries(sectionView), section.entries)
  assert.equal(countFaceCatalog(face).entries, 328)

  const wideEyes = visibleFaceSections(face, '', 'wide eyes')
  const wideEyesRows = face.体系.flatMap((item) => item.分类.flatMap((category) => category.词条)).filter((entry) => entry.提示词 === 'wide eyes')
  assert.equal(countVisibleFaceEntries(wideEyes), wideEyesRows.length)
  assert.ok(wideEyesRows.length > 1)
  assert.equal(countFaceCatalog(face).entries, counts.entries)

  const byCategoryName = visibleFaceSections(face, '', '基础微笑')
  const basic = face.体系.flatMap((item) => item.分类).find((category) => category.名称 === '基础微笑')
  assert.ok(basic)
  assert.equal(countVisibleFaceEntries(byCategoryName), basic.词条.length)
})

test('表情提示词排在身材之后，并参与复制文本的重写与清空', () => {
  const base = recipe({ bodyTags: [' slender ', 'athletic'], faceTags: ['soft smile', 'soft smile', ' gentle smile '] })
  const lines = recipeTagLines(base)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^• 身材：/)
  assert.match(lines[1], /^• 表情：/)
  assert.match(lines[0], /slender, athletic/)
  assert.match(lines[1], /soft smile, gentle smile/)

  const prompt = '请生成一张完整的人物图像：\n• 人物：保持图1。\n• 风格：写实。\n• 表情：过期表情\n画面中没有任何文字、标志或水印。'
  const next = applyRecipeTagPrompt(prompt, base)
  const bodyAt = next.indexOf('• 身材：')
  const faceAt = next.indexOf('• 表情：')
  const styleAt = next.indexOf('• 风格：')
  const markAt = next.indexOf('画面中没有任何文字、标志或水印。')
  assert.ok(styleAt >= 0 && bodyAt > styleAt && faceAt > bodyAt && markAt > faceAt)
  assert.equal(next.split('• 表情：').length - 1, 1)
  assert.match(next, /gentle smile/)
  assert.equal(next.includes('过期表情'), false)
  assert.match(next, /• 人物：保持图1。/)

  const cleared = applyRecipeTagPrompt(next, recipe({ bodyTags: ['slender'] }))
  assert.equal(cleared.includes('• 表情：'), false)
  assert.match(cleared, /• 身材：/)
  const empty = applyRecipeTagPrompt(cleared, recipe())
  assert.equal(empty.includes('• 身材：'), false)
  assert.equal(empty.includes('• 表情：'), false)
  assert.match(empty, /画面中没有任何文字、标志或水印。/)

  const added = addTags(['soft smile'], [' gentle smile ', 'soft smile', ''])
  assert.deepEqual(added.added, ['gentle smile'])
  assert.deepEqual(added.tags, ['soft smile', 'gentle smile'])
  assert.deepEqual(removeTag(added.tags, 'soft smile'), ['gentle smile'])
})
