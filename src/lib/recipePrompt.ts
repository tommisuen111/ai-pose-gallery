import type { RecipeState } from '@/types/gallery'

const TAG_LINE_PREFIXES = ['• 身材：', '• 表情：']
const WATERMARK = '画面中没有任何文字、标志或水印。'

function cleanTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).map((tag) => tag.trim()).filter(Boolean)
}

export function bodyPromptLine(recipe: RecipeState): string {
  const tags = cleanTags(recipe.bodyTags)
  if (!tags.length) return ''
  return `• 身材：人物的体型与比例需符合以下特征：${tags.join(', ')}。保持各特征之间协调，不改变参考图中人物的脸型、五官与身份。`
}

export function facePromptLine(recipe: RecipeState): string {
  const tags = cleanTags(recipe.faceTags)
  if (!tags.length) return ''
  return `• 表情：人物的面部表情需符合以下特征：${tags.join(', ')}。只调整表情与神态，不改变参考图中人物的脸型、五官结构、身份与身材。`
}

/** 身材在前，表情紧随其后。空标签不产生行。 */
export function recipeTagLines(recipe: RecipeState): string[] {
  return [bodyPromptLine(recipe), facePromptLine(recipe)].filter(Boolean)
}

/**
 * 用当前配方重写身材行与表情行。
 * 自定义提示词里过期的这两行会被替换，其他文字保留；两行始终按身材、表情的顺序放在水印句之前。
 */
export function applyRecipeTagPrompt(prompt: string, recipe: RecipeState): string {
  const lines = recipeTagLines(recipe)
  const cleaned = prompt
    .split('\n')
    .filter((row) => !TAG_LINE_PREFIXES.some((prefix) => row.startsWith(prefix)))
    .join('\n')
    .trimEnd()
  if (!lines.length) return cleaned
  const block = lines.join('\n')
  const at = cleaned.lastIndexOf(WATERMARK)
  if (at >= 0) return `${cleaned.slice(0, at).trimEnd()}\n${block}\n${cleaned.slice(at)}`
  return cleaned ? `${cleaned}\n${block}` : block
}

/** 汇总身材与表情标签。重复调用只会保留当前配方里的一组描述。 */
export function applyBodyPrompt(prompt: string, recipe: RecipeState): string {
  return applyRecipeTagPrompt(prompt, recipe)
}
