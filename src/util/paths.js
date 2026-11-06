/** Tiny dotted-path helpers shared by gates, builders and the UI. */

export function getByPath(object, path, fallback = undefined) {
  if (!path) return object
  const parts = String(path)
    .replaceAll(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let node = object
  for (const part of parts) {
    if (node === null || node === undefined) return fallback
    if (typeof node !== 'object') return fallback
    node = node[part]
  }
  return node === undefined ? fallback : node
}

export function setByPath(object, path, value) {
  const parts = String(path)
    .replaceAll(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let node = object
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (node[part] === null || typeof node[part] !== 'object') {
      node[part] = /^\d+$/.test(parts[index + 1]) ? [] : {}
    }
    node = node[part]
  }
  node[parts[parts.length - 1]] = value
  return object
}

/** Return every value selected by a path that may contain `[]` wildcards. */
export function getByPathValues(object, path) {
  const parts = String(path)
    .replaceAll(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  const walk = (node, index) => {
    if (index >= parts.length) return node === undefined ? [] : [node]
    if (node === null || node === undefined) return []
    const part = parts[index]
    if (part.endsWith('[]')) {
      const key = part.slice(0, -2)
      const list = node[key]
      if (!Array.isArray(list)) return []
      return list.flatMap((item) => walk(item, index + 1))
    }
    if (Array.isArray(node) && /^\d+$/.test(part)) return walk(node[Number(part)], index + 1)
    if (typeof node !== 'object') return []
    return walk(node[part], index + 1)
  }
  return walk(object, 0)
}

/** For a path ending in `[]`, return the array itself before the wildcard. */
export function getPathArray(object, path) {
  const text = String(path)
  const index = text.indexOf('[]')
  if (index < 0) return getByPath(object, text)
  const base = text.slice(0, index)
  const list = getByPath(object, base)
  return Array.isArray(list) ? list : []
}

/** Normalize a field path for display and pinning. */
export function pathLabel(path) {
  return String(path).replace(/^data\./, '')
}
