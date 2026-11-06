/**
 * A deliberately small YAML reader for the manifest subset this plugin owns.
 *
 * Supported: block mappings, block sequences, nested blocks, inline arrays and
 * maps, quoted strings, numbers, booleans, null, comments, literal/folded block
 * scalars. Not supported: anchors, aliases, tags, multiple documents, merge
 * keys, complex keys. The reader throws a path-aware error instead of guessing.
 */

import { EquityError } from './json.js'

function fail(message, line) {
  throw new EquityError('invalid_yaml', `${message}${line ? `（第 ${line.number} 行）` : ''}`, {
    line: line?.number,
  })
}

function stripComment(text) {
  let single = false
  let double = false
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const prev = text[i - 1]
    if (double) {
      if (char === '\\') i += 1
      else if (char === '"') double = false
      continue
    }
    if (single) {
      if (char === "'" && text[i + 1] === "'") i += 1
      else if (char === "'") single = false
      continue
    }
    if (char === '"') double = true
    else if (char === "'") single = true
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth = Math.max(0, depth - 1)
    else if (char === '#' && depth === 0 && (i === 0 || /\s/.test(prev))) return text.slice(0, i)
  }
  return text
}

function splitTopLevel(text, separator) {
  const parts = []
  let start = 0
  let single = false
  let double = false
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (double) {
      if (char === '\\') i += 1
      else if (char === '"') double = false
      continue
    }
    if (single) {
      if (char === "'" && text[i + 1] === "'") i += 1
      else if (char === "'") single = false
      continue
    }
    if (char === '"') double = true
    else if (char === "'") single = true
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth = Math.max(0, depth - 1)
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function splitKeyValue(text) {
  let single = false
  let double = false
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (double) {
      if (char === '\\') i += 1
      else if (char === '"') double = false
      continue
    }
    if (single) {
      if (char === "'" && text[i + 1] === "'") i += 1
      else if (char === "'") single = false
      continue
    }
    if (char === '"') double = true
    else if (char === "'") single = true
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth = Math.max(0, depth - 1)
    else if (char === ':' && depth === 0) {
      const next = text[i + 1]
      if (next === undefined || /\s/.test(next)) {
        return { key: text.slice(0, i).trim(), value: text.slice(i + 1).trim() }
      }
    }
  }
  return null
}

function parseQuoted(text, line) {
  const first = text[0]
  const last = text[text.length - 1]
  if (first === '"' && last === '"') {
    try {
      return JSON.parse(text)
    } catch {
      fail(`双引号字符串不合法：${text}`, line)
    }
  }
  if (first === "'" && last === "'") return text.slice(1, -1).replaceAll("''", "'")
  return null
}

function parseInline(text, line) {
  const value = text.trim()
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return null
  if (value === 'true' || value === 'True' || value === 'TRUE') return true
  if (value === 'false' || value === 'False' || value === 'FALSE') return false
  if (/^-?\d+$/.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : value
  }
  if (/^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('"') || value.startsWith("'")) {
    const quoted = parseQuoted(value, line)
    if (quoted !== null) return quoted
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return splitTopLevel(inner, ',').map((part) => parseInline(part, line))
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return {}
    const out = {}
    for (const part of splitTopLevel(inner, ',')) {
      const pair = splitKeyValue(part)
      if (!pair) fail(`内联映射缺少冒号：${part}`, line)
      out[parseInline(pair.key, line)] = parseInline(pair.value, line)
    }
    return out
  }
  if (value.startsWith('&') || value.startsWith('*') || value.startsWith('!!')) {
    fail(`不支持锚点/别名/标签：${value}`, line)
  }
  return value
}

function readLines(text) {
  const raw = String(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const lines = []
  for (let index = 0; index < raw.length; index += 1) {
    const original = raw[index]
    if (/^\s*---\s*$/.test(original)) continue
    if (/^\s*\.\.\.\s*$/.test(original)) break
    const match = /^( *)(.*)$/.exec(original)
    if (!match) fail('无法解析行', { number: index + 1 })
    const indent = match[1].length
    if (/^\t/.test(match[2])) fail('缩进不能使用 Tab', { number: index + 1 })
    const content = stripComment(match[2]).replace(/\s+$/, '')
    if (!content.trim()) continue
    lines.push({ indent, content, raw: original, number: index + 1 })
  }
  return lines
}

function isSequenceLine(line) {
  return line.content === '-' || line.content.startsWith('- ')
}

function childIndent(lines, index, parentIndent) {
  if (index >= lines.length) return null
  return lines[index].indent > parentIndent ? lines[index].indent : null
}

function parseBlockScalar(lines, index, parentIndent, style) {
  const collected = []
  let cursor = index
  while (cursor < lines.length && lines[cursor].indent > parentIndent) {
    collected.push(lines[cursor])
    cursor += 1
  }
  if (collected.length === 0) return ['', cursor]
  const minIndent = Math.min(...collected.map((line) => line.indent))
  const parts = collected.map((line) => ' '.repeat(Math.max(0, line.indent - minIndent)) + line.content)
  const text = style === '>' ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n')
  return [style === '|' ? text + '\n' : text, cursor]
}

function parseMap(lines, index, indent) {
  const out = {}
  let cursor = index
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.indent < indent) break
    if (line.indent > indent) fail('缩进异常', line)
    if (isSequenceLine(line)) break
    const pair = splitKeyValue(line.content)
    if (!pair) fail(`映射项缺少冒号：${line.content}`, line)
    if (pair.key === '') fail('映射键不能为空', line)
    const key = parseInline(pair.key, line)
    if (typeof key !== 'string' || key === '') fail(`映射键必须是字符串：${line.content}`, line)
    if (Object.hasOwn(out, key)) fail(`重复键：${key}`, line)
    const valueText = pair.value
    if (valueText === '|' || valueText === '>') {
      const [value, next] = parseBlockScalar(lines, cursor + 1, indent, valueText)
      out[key] = value
      cursor = next
      continue
    }
    if (valueText === '') {
      const nextIndent = childIndent(lines, cursor + 1, indent)
      if (nextIndent === null) {
        out[key] = null
        cursor += 1
        continue
      }
      const [value, next] = parseBlock(lines, cursor + 1, nextIndent)
      out[key] = value
      cursor = next
      continue
    }
    out[key] = parseInline(valueText, line)
    cursor += 1
  }
  return [out, cursor]
}

function parseSequenceItem(line, lines, cursor, indent) {
  const rest = line.content === '-' ? '' : line.content.slice(2).trim()
  if (rest === '') {
    const nextIndent = childIndent(lines, cursor + 1, indent)
    if (nextIndent === null) return [null, cursor + 1]
    return parseBlock(lines, cursor + 1, nextIndent)
  }
  const pair = splitKeyValue(rest)
  if (!pair || rest.startsWith('[') || rest.startsWith('{') || rest.startsWith('"') || rest.startsWith("'")) {
    return [parseInline(rest, line), cursor + 1]
  }
  if (!pair) return [parseInline(rest, line), cursor + 1]
  // A sequence item that begins with `key: value` is a mapping item. Its first
  // key may itself own a nested block; following keys sit at a deeper indent.
  const first = {}
  const key = parseInline(pair.key, line)
  if (typeof key !== 'string' || key === '') fail(`映射键必须是字符串：${rest}`, line)
  const valueText = pair.value
  let next = cursor + 1
  if (valueText === '|' || valueText === '>') {
    const [value, after] = parseBlockScalar(lines, next, indent, valueText)
    first[key] = value
    next = after
  } else if (valueText === '') {
    const nextIndent = childIndent(lines, next, indent)
    if (nextIndent === null) {
      first[key] = null
    } else {
      const [value, after] = parseBlock(lines, next, nextIndent)
      first[key] = value
      next = after
    }
  } else {
    first[key] = parseInline(valueText, line)
  }
  // Remaining keys of this item are indented more than the dash.
  if (next < lines.length && lines[next].indent > indent && !isSequenceLine(lines[next])) {
    const mapIndent = lines[next].indent
    const [restMap, after] = parseMap(lines, next, mapIndent)
    Object.assign(first, restMap)
    next = after
  }
  return [first, next]
}

function parseSequence(lines, index, indent) {
  const out = []
  let cursor = index
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.indent < indent) break
    if (line.indent > indent) fail('缩进异常', line)
    if (!isSequenceLine(line)) break
    const [value, next] = parseSequenceItem(line, lines, cursor, indent)
    out.push(value)
    cursor = next
  }
  return [out, cursor]
}

function parseBlock(lines, index, indent) {
  if (index >= lines.length) return [null, index]
  const line = lines[index]
  if (line.indent < indent) return [null, index]
  if (isSequenceLine(line)) return parseSequence(lines, index, indent)
  return parseMap(lines, index, indent)
}

/**
 * Parse the supported YAML subset.
 * @param {string} text
 * @returns {unknown}
 */
export function parseYaml(text) {
  const lines = readLines(text)
  if (lines.length === 0) return null
  const [value, cursor] = parseBlock(lines, 0, lines[0].indent)
  if (cursor < lines.length) fail('文件末尾存在无法归属的内容', lines[cursor])
  return value
}

/** Parse a YAML object and require a mapping root. */
export function parseYamlObject(text, source = 'yaml') {
  const value = parseYaml(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EquityError('invalid_yaml_root', `${source} 的根必须是映射`, { source })
  }
  return value
}

function needsQuote(text) {
  return /^(?:$|[-?:,[\]{}#&*!|>'"%@`]|\s)|: |\s#|[\n\r\t]/.test(text)
}

function scalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  return needsQuote(text) ? JSON.stringify(text) : text
}

function emit(value, indent) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    const lines = []
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item)
        if (entries.length === 0) {
          lines.push(`${pad}- {}`)
          continue
        }
        const [firstKey, firstValue] = entries[0]
        if (firstValue !== null && typeof firstValue === 'object') {
          lines.push(`${pad}- ${firstKey}:`)
          lines.push(...emit(firstValue, indent + 4))
        } else {
          lines.push(`${pad}- ${firstKey}: ${scalar(firstValue)}`)
        }
        for (const [key, child] of entries.slice(1)) {
          if (child !== null && typeof child === 'object') {
            lines.push(`${pad}  ${key}:`)
            lines.push(...emit(child, indent + 4))
          } else {
            lines.push(`${pad}  ${key}: ${scalar(child)}`)
          }
        }
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`)
        lines.push(...emit(item, indent + 2))
      } else {
        lines.push(`${pad}- ${scalar(item)}`)
      }
    }
    return lines
  }
  if (value !== null && typeof value === 'object') {
    const lines = []
    for (const [key, child] of Object.entries(value)) {
      if (child !== null && typeof child === 'object') {
        lines.push(`${pad}${key}:`)
        lines.push(...emit(child, indent + 2))
      } else {
        lines.push(`${pad}${key}: ${scalar(child)}`)
      }
    }
    return lines
  }
  return [`${pad}${scalar(value)}`]
}

/** Serialize a plain object/array to the same YAML subset this reader accepts. */
export function stringifyYaml(value) {
  const lines = emit(value, 0)
  return lines.join('\n') + '\n'
}
