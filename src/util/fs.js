import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { EquityError, canonicalJson, parseJson } from './json.js'

/** Resolve a path and guarantee it stays inside root. */
export function resolveInside(root, relativePath) {
  const base = resolve(root)
  const target = resolve(base, String(relativePath ?? ''))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new EquityError('path_escape', `路径越界：${relativePath}`, { root: base, target })
  }
  return target
}

/** Replace characters that break Windows paths; reject traversal segments. */
export function safeSegment(value, fallback = '_') {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  if (text === '.' || text === '..' || text.includes('\0')) {
    throw new EquityError('bad_segment', `非法路径片段：${text}`)
  }
  return text
    .replaceAll(/[\\/:*?"<>|]/g, '_')
    .replaceAll(/\s+/g, '_')
    .slice(0, 96) || fallback
}

/** Ensure a directory exists. */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

/** Write text atomically (temp file + rename, with a Windows replace retry). */
export async function atomicWriteText(file, text) {
  await ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EEXIST' || error?.code === 'EACCES') {
      await rm(file, { force: true })
      await rename(tmp, file)
    } else {
      await rm(tmp, { force: true })
      throw error
    }
  }
}

/** Write JSON atomically with stable formatting. */
export async function atomicWriteJson(file, value) {
  await atomicWriteText(file, JSON.stringify(value, null, 2) + '\n')
}

/** Read JSON; return fallback when missing. */
export async function readJson(file, fallback = undefined) {
  try {
    const text = await readFile(file, 'utf8')
    return parseJson(text, file)
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

/** Read UTF-8 text; return fallback when missing. */
export async function readText(file, fallback = undefined) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

/** Read a JSONL file and skip malformed trailing lines with a warning. */
export async function readJsonLines(file) {
  const text = await readText(file, '')
  const out = []
  const warnings = []
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      warnings.push({ file, line: index + 1 })
    }
  }
  return { lines: out, warnings }
}

/** Append one JSON line. */
export async function appendJsonLine(file, value) {
  await ensureDir(dirname(file))
  await appendFile(file, JSON.stringify(value) + '\n', 'utf8')
}

/** Stat or null. */
export async function statOrNull(file) {
  try {
    return await stat(file)
  } catch {
    return null
  }
}

/** True when path exists. */
export function exists(file) {
  return existsSync(file)
}

/** List files under a directory recursively; returns absolute paths. */
export async function listFiles(dir, options = {}) {
  const { filter = () => true, maxDepth = 8, depth = 0 } = options
  if (depth > maxDepth) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full, { ...options, depth: depth + 1 })))
    } else if (entry.isFile() && filter(full, entry)) {
      out.push(full)
    }
  }
  return out
}

/** Copy a file, creating parents. */
export async function copyFileInto(source, target) {
  await ensureDir(dirname(target))
  await copyFile(source, target)
}

/** Move a file or directory to `.equity/.trash` instead of deleting it. */
export async function moveToTrash(projectRoot, target, trashDir = join(projectRoot, '.equity', '.trash')) {
  const inside = resolveInside(projectRoot, target)
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '')
  const destination = join(trashDir, `${stamp}-${basename(inside)}`)
  await ensureDir(trashDir)
  await rename(inside, destination)
  return destination
}

/** Hash a file without loading it fully into memory. */
export async function hashFile(file) {
  const data = await readFile(file)
  return 'sha256:' + createHash('sha256').update(data).digest('hex')
}

/** Return a relative path with forward slashes for portable manifests. */
export function portableRelative(root, file) {
  const base = resolve(root)
  const target = resolve(file)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new EquityError('path_escape', `路径不在项目内：${file}`)
  }
  return target.slice(base.length + (target === base ? 0 : 1)).replaceAll('\\', '/')
}

/** Convert a portable relative path to an absolute path inside root. */
export function portableJoin(root, relativePath) {
  if (isAbsolute(relativePath)) {
    return resolveInside(root, relativePath)
  }
  return resolveInside(root, relativePath.replaceAll('/', sep))
}

/** Delete a temporary directory safely. */
export async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true })
}

/** Stable hash of a value written as canonical JSON. */
export function hashJson(value) {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex')
}
