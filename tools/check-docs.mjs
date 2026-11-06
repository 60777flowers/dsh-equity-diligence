#!/usr/bin/env node
/**
 * 文档一致性检查（针对对外文档 README.md）：
 *   1. "目录" 与正文 "## N." 标题逐条对应：编号连续、标题一致、锚点可解析
 *   2. 禁止裸写有歧义的模块数（24 有三个含义，见 docs/术语与计数口径.md）
 *   3. "六态" 必须说明实际是 8 个取值
 *   4. README 内的相对链接必须指向真实存在的文件
 *
 * 用法：node tools/check-docs.mjs [--fix-hint]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readmePath = join(root, 'README.md')
const errors = []
const warnings = []

/** GitHub heading slug：小写、去标点（保留 - _）、空格转连字符。 */
function slugify(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

function addError(file, line, message) {
  errors.push(`${file}:${line}: ${message}`)
}

const text = readFileSync(readmePath, 'utf8')
const lines = text.split(/\r?\n/)

// ---------------------------------------------------------------- 1. 目录 ↔ 标题
const headings = []
lines.forEach((line, index) => {
  const match = /^##\s+(\d+)\.\s+(.+?)\s*$/.exec(line)
  if (match) headings.push({ line: index + 1, number: Number(match[1]), title: match[2] })
})

headings.forEach((heading, index) => {
  if (heading.number !== index + 1) {
    addError('README.md', heading.line, `标题编号不连续：期望 ${index + 1}，实际 ${heading.number}（"${heading.title}"）`)
  }
})

const toc = []
let inToc = false
lines.forEach((line, index) => {
  if (/^##\s+目录\s*$/.test(line)) {
    inToc = true
    return
  }
  if (inToc && /^##\s+/.test(line)) inToc = false
  if (!inToc) return
  const match = /^-\s+\[(\d+)\.\s+(.+?)\]\(#(.+?)\)\s*$/.exec(line.trim())
  if (match) toc.push({ line: index + 1, number: Number(match[1]), title: match[2], anchor: match[3] })
})

if (toc.length === 0) addError('README.md', 1, '未找到"目录"条目')

const byNumber = new Map(headings.map((heading) => [heading.number, heading]))
for (const entry of toc) {
  const heading = byNumber.get(entry.number)
  if (!heading) {
    addError('README.md', entry.line, `目录指向第 ${entry.number} 节，但正文没有该编号的标题`)
    continue
  }
  if (heading.title !== entry.title) {
    addError('README.md', entry.line, `目录标题与正文不一致：目录"${entry.title}" ≠ 正文"${heading.title}"（正文第 ${heading.line} 行）`)
  }
  const expected = slugify(`${heading.number}. ${heading.title}`)
  if (entry.anchor !== expected) {
    addError('README.md', entry.line, `锚点不可解析：写的是 #${entry.anchor}，按 GitHub 规则应为 #${expected}`)
  }
}
for (const heading of headings) {
  if (!toc.some((entry) => entry.number === heading.number)) {
    addError('README.md', heading.line, `正文第 ${heading.number} 节"${heading.title}"未出现在目录中`)
  }
}

// ---------------------------------------------------------------- 2. 歧义的模块数
// 24 个模块 / 24 个方向 / 24 个内置 / 24 个业务 都可能指三个不同含义，必须带限定语。
const ambiguous = [/24\s*个模块/, /24\s*个方向/, /24\s*个内置/, /24\s*个业务/]
const allowedQualifiers = /(预设|deep|AI|调查类|专用|骨架|初稿|兜底|构建器)/
lines.forEach((line, index) => {
  for (const pattern of ambiguous) {
    if (pattern.test(line) && !allowedQualifiers.test(line)) {
      addError('README.md', index + 1, `模块数表述有歧义：「${line.trim().slice(0, 60)}」。24 有三个含义，请写清是"AI 初稿""调查类模块"还是"deep 预设启用数"`)
    }
  }
})

// ---------------------------------------------------------------- 3. 六态 = 8 个取值
lines.forEach((line, index) => {
  if (/六态/.test(line) && !/(8\s*个取值|8\s*值)/.test(line)) {
    addError('README.md', index + 1, `出现"六态"但未说明实际是 8 个取值：「${line.trim().slice(0, 60)}」`)
  }
})

// ---------------------------------------------------------------- 4. 相对链接可解析
const linkPattern = /\[[^\]]*\]\((?!https?:|#|mailto:)([^)]+)\)/g
lines.forEach((line, index) => {
  for (const match of line.matchAll(linkPattern)) {
    const target = match[1].split('#')[0].trim()
    if (!target) continue
    const resolved = resolve(root, target)
    if (!existsSync(resolved)) {
      addError('README.md', index + 1, `相对链接指向不存在的路径：${target}`)
    }
  }
})

// ---------------------------------------------------------------- 5. docs 里的裸写 24（仅提示）
// 术语与计数口径.md 是规则本身，必然出现这些字样，跳过。
const SKIP_DOCS = new Set(['术语与计数口径.md'])
const { readdirSync } = await import('node:fs')
const docsDir = join(root, 'docs')
if (existsSync(docsDir)) {
  for (const name of readdirSync(docsDir)) {
    if (!name.endsWith('.md') || SKIP_DOCS.has(name)) continue
    const file = join('docs', name)
    const docLines = readFileSync(join(root, file), 'utf8').split(/\r?\n/)
    docLines.forEach((line, index) => {
      if (allowedQualifiers.test(line)) return
      if (!ambiguous.some((pattern) => pattern.test(line))) return
      warnings.push(`${file}:${index + 1}: 疑似歧义「${line.trim().slice(0, 60)}」`)
    })
  }
}

// ---------------------------------------------------------------- 输出
if (warnings.length) {
  console.log(`文档提示 ${warnings.length} 条：`)
  for (const item of warnings) console.log(`  · ${item}`)
}
if (errors.length) {
  console.error(`\n文档一致性检查失败，共 ${errors.length} 条：`)
  for (const item of errors) console.error(`  ✖ ${item}`)
  process.exit(1)
}
console.log(`docs ok (${headings.length} sections, ${toc.length} toc entries, ${warnings.length} warnings)`)
