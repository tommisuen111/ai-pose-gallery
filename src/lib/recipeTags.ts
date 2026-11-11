export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
}

export function addTags(existing: readonly string[] | undefined, incoming: readonly string[]): { tags: string[]; added: string[] } {
  const current = normalizeTags(existing ?? [])
  const added = normalizeTags(incoming).filter((tag) => !current.includes(tag))
  return { tags: [...current, ...added], added }
}

export function removeTag(existing: readonly string[] | undefined, tag: string): string[] {
  const clean = tag.trim()
  return (existing ?? []).filter((item) => item !== clean)
}

export function toggleTag(existing: readonly string[] | undefined, tag: string): { tags: string[]; selected: boolean } {
  const clean = tag.trim()
  const current = existing ?? []
  if (!clean) return { tags: normalizeTags(current), selected: false }
  const selected = current.includes(clean)
  return {
    tags: selected ? current.filter((item) => item !== clean) : normalizeTags([...current, clean]),
    selected,
  }
}
