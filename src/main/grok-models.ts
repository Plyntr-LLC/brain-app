export function parseGrokModels(raw: string): { id: string; label: string }[] {
  const found = [...String(raw || '').matchAll(/^\s*[* -]+\s*(grok-[a-z0-9.]+(?:-[a-z0-9.]+)*)/gim)].map((x) => x[1])
  return [...new Set(found)].map((id) => ({ id, label: id }))
}
