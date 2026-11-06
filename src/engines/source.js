import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { join } from 'node:path'

import { EquityError, sha256 } from '../util/json.js'
import { appendJsonLine, atomicWriteJson, ensureDir, readJson, readText } from '../util/fs.js'
import { PACKAGE_ROOT } from '../kernel/registry.js'
import { nowIso } from '../util/time.js'

const execFileAsync = promisify(execFile)

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i
const TRACKING = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'from', 'source'])

export function canonicalizeUrl(input) {
  const url = new URL(input)
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.has(key.toLowerCase())) url.searchParams.delete(key)
  }
  return url.toString()
}

export function assertPublicUrl(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new EquityError('bad_url', `URL 不合法：${input}`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new EquityError('bad_url', `只允许 http/https：${input}`)
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new EquityError('blocked_url', `拒绝访问本机/内网地址：${url.hostname}`)
  }
  return url
}

export function htmlToText(html) {
  return String(html ?? '')
    .replaceAll(/<script[\s\S]*?<\/script>/gi, ' ')
    .replaceAll(/<style[\s\S]*?<\/style>/gi, ' ')
    .replaceAll(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/<br\s*\/?>/gi, '\n')
    .replaceAll(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/&nbsp;/gi, ' ')
    .replaceAll(/&amp;/gi, '&')
    .replaceAll(/&lt;/gi, '<')
    .replaceAll(/&gt;/gi, '>')
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&#39;/gi, "'")
    .replaceAll(/\r\n/g, '\n')
    .replaceAll(/[ \t]+/g, ' ')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

export function titleFromHtml(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))
  return match ? htmlToText(match[1]).replaceAll(/\s+/g, ' ').trim() : ''
}

export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replaceAll(/\s+/g, '')
    .replaceAll(/[“”"'‘’]/g, '')
    .replaceAll(/[，。；：、,.;:]/g, '')
    .toLowerCase()
}

function bigrams(text) {
  const set = new Set()
  for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2))
  return set
}

/** Exact or fuzzy quote match. */
export function quoteMatch(text, quote) {
  const source = normalizeText(text)
  const needle = normalizeText(quote)
  if (!needle) return { matched: false, method: 'empty' }
  const index = source.indexOf(needle)
  if (index >= 0) return { matched: true, method: 'quote-exact', index, ratio: 1 }
  if (needle.length < 8) return { matched: false, method: 'too-short' }
  const a = bigrams(source)
  const b = bigrams(needle)
  if (b.size === 0) return { matched: false, method: 'too-short' }
  let hits = 0
  for (const gram of b) if (a.has(gram)) hits += 1
  const ratio = hits / b.size
  return { matched: ratio >= 0.9, method: 'quote-fuzzy', ratio }
}

export function sourceTierFromUrl(input) {
  let host = ''
  try {
    host = new URL(input).hostname.toLowerCase()
  } catch {
    return 'media'
  }
  if (/cninfo|sse\.com\.cn|szse\.cn|bse\.cn|hkexnews|hkex\.com/.test(host)) return 'announcement'
  if (/court\.gov\.cn|wenshu|zxgk|pkulaw|lawinfochina/.test(host)) return 'court'
  if (/csrc\.gov\.cn|amac\.org\.cn|gov\.cn|samr\.gov\.cn|stats\.gov\.cn|customs\.gov\.cn|tax\.gov\.cn/.test(host)) return 'regulator'
  if (/gsxt\.gov\.cn|qcc\.com|tianyancha|qixin|aiqicha|shuidi/.test(host)) return 'registry'
  if (/cninfo|eastmoney|hexun|sina|10jqka|wind|choice/.test(host)) return 'database'
  if (/company|official/.test(host)) return 'company'
  return 'media'
}

/**
 * SourceAcquisition owns all network access for the plugin.
 * Search is isolated per query; fetch records status/finalUrl/truncation/hash.
 */
export class SourceAcquisition {
  constructor({ ctx, root, projectId, signal = undefined }) {
    this.ctx = ctx
    this.root = root
    this.projectId = projectId
    this.signal = signal
    this.attempts = []
    this.cacheTtlMs = 6 * 60 * 60 * 1000
  }

  async egress(kind, payload) {
    try {
      await ensureDir(join(this.root, '.equity', 'logs'))
      await appendJsonLine(join(this.root, '.equity', 'logs', 'egress.jsonl'), {
        at: nowIso(),
        projectId: this.projectId,
        kind,
        ...payload,
      })
    } catch {
      // audit logging must never break retrieval
    }
  }

  /** One search; never throws for provider failures. */
  async search(query, { maxResults = 8 } = {}) {
    const attempt = { query, engine: 'web', at: nowIso(), resultCount: 0, outcome: 'ok', note: '' }
    try {
      if (!this.ctx.web) throw new EquityError('web_unavailable', 'WEB_PROVIDER_UNAVAILABLE')
      const result = await this.ctx.web.search({ query, maxResults }, this.signal)
      attempt.resultCount = result.sources?.length ?? 0
      attempt.outcome = result.sources?.length ? 'ok' : 'empty'
      attempt.truncated = result.truncated
      this.attempts.push(attempt)
      await this.egress('search', { query, resultCount: attempt.resultCount, outcome: attempt.outcome })
      return {
        ok: true,
        query,
        sources: (result.sources ?? []).map((source) => ({
          ...source,
          sourceTier: sourceTierFromUrl(source.url),
        })),
        content: result.content ?? null,
        truncated: result.truncated,
        attempt,
      }
    } catch (error) {
      attempt.outcome = 'error'
      attempt.note = `${error.code ?? 'search_error'}: ${error.message}`
      this.attempts.push(attempt)
      await this.egress('search', { query, outcome: 'error', error: attempt.note })
      return { ok: false, query, sources: [], error: { code: error.code ?? 'search_error', message: error.message }, attempt }
    }
  }

  async fetch(url, { useCache = true } = {}) {
    const canonical = canonicalizeUrl(url)
    assertPublicUrl(canonical)
    const cacheKey = createHash('sha256').update(canonical).digest('hex')
    const cacheFile = join(this.root, '.equity', 'cache', 'fetch', `${cacheKey}.json`)
    if (useCache) {
      const cached = await readJson(cacheFile, null)
      if (cached && Date.now() - Date.parse(cached.fetchedAt) < this.cacheTtlMs) {
        await this.egress('fetch', { url: canonical, cache: true, statusCode: cached.statusCode })
        return { ...cached, cacheHit: true }
      }
    }
    try {
      if (!this.ctx.web) throw new EquityError('web_unavailable', 'WEB_PROVIDER_UNAVAILABLE')
      const result = await this.ctx.web.fetch({ url: canonical }, this.signal)
      const isHtml = result.body.kind === 'html'
      const content = result.body.content ?? ''
      const text = isHtml ? htmlToText(content) : content
      const record = {
        ok: true,
        url: canonical,
        finalUrl: result.url,
        statusCode: result.statusCode,
        kind: result.body.kind,
        html: isHtml ? content : null,
        text,
        title: isHtml ? titleFromHtml(content) : '',
        truncated: result.truncated,
        rawHash: sha256(text),
        fetchedAt: nowIso(),
        cacheHit: false,
        sourceTier: sourceTierFromUrl(result.url),
      }
      await ensureDir(join(this.root, '.equity', 'cache', 'fetch'))
      await atomicWriteJson(cacheFile, record)
      await this.egress('fetch', { url: canonical, finalUrl: record.finalUrl, statusCode: record.statusCode, truncated: record.truncated })
      return record
    } catch (error) {
      const record = {
        ok: false,
        url: canonical,
        finalUrl: canonical,
        statusCode: null,
        kind: null,
        text: '',
        title: '',
        truncated: false,
        rawHash: null,
        fetchedAt: nowIso(),
        cacheHit: false,
        error: { code: error.code ?? 'fetch_error', message: error.message },
      }
      await this.egress('fetch', { url: canonical, error: record.error })
      return record
    }
  }

  /** Download a PDF and extract page text with the bundled Python helper. */
  async fetchPdf(url) {
    assertPublicUrl(url)
    const canonical = canonicalizeUrl(url)
    try {
      const response = await fetch(canonical, { signal: this.signal })
      if (!response.ok) {
        return { ok: false, url: canonical, statusCode: response.status, error: { code: 'http_error', message: `HTTP ${response.status}` } }
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      const dir = join(this.root, '.equity', 'cache', 'pdf')
      await ensureDir(dir)
      const file = join(dir, `${createHash('sha256').update(buffer).digest('hex')}.pdf`)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(file, buffer)
      const python = process.env.EQUITY_PYTHON || process.env.PYTHON || 'python'
      const { stdout } = await execFileAsync(python, [join(PACKAGE_ROOT, 'python', 'pdf_extract.py'), file], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      })
      const parsed = JSON.parse(stdout)
      await this.egress('fetch-pdf', { url: canonical, pages: parsed.pages?.length ?? 0 })
      return {
        ok: true,
        url: canonical,
        finalUrl: canonical,
        statusCode: response.status,
        kind: 'pdf',
        pages: parsed.pages ?? [],
        text: (parsed.pages ?? []).map((page) => `[p.${page.page}]\n${page.text}`).join('\n\n'),
        title: parsed.title ?? '',
        truncated: false,
        rawHash: sha256(buffer),
        fetchedAt: nowIso(),
        sourceTier: 'announcement',
      }
    } catch (error) {
      return { ok: false, url: canonical, error: { code: error.code ?? 'pdf_error', message: error.message } }
    }
  }

  /** Import a local text/PDF file as evidence text. */
  async importFile(file) {
    const text = await readText(file, null)
    if (text !== null) {
      return { ok: true, url: `file://${file}`, finalUrl: `file://${file}`, title: file, text, kind: 'text', statusCode: null, truncated: false, rawHash: sha256(text), fetchedAt: nowIso(), sourceTier: 'import' }
    }
    return this.fetchPdf(file)
  }

  /** Verify one evidence record's URL and quote. */
  async verifyEvidence(evidence) {
    if (!evidence?.url || evidence.url.startsWith('file://')) {
      return { ...evidence, verificationStatus: evidence.verificationStatus ?? 'unverified', verification: { method: 'manual', checkedAt: nowIso(), matches: false } }
    }
    const result = evidence.url.toLowerCase().endsWith('.pdf') ? await this.fetchPdf(evidence.url) : await this.fetch(evidence.url, { useCache: false })
    if (!result.ok) {
      return { ...evidence, verificationStatus: 'unreachable', verification: { method: 'provider', checkedAt: nowIso(), matches: false, statusCode: result.statusCode ?? null } }
    }
    const match = quoteMatch(result.text, evidence.quote)
    return {
      ...evidence,
      finalUrl: result.finalUrl,
      rawHash: result.rawHash,
      verificationStatus: match.matched ? 'verified' : result.statusCode >= 200 && result.statusCode < 300 ? 'partial' : 'unreachable',
      verification: {
        method: match.matched ? 'quote-exact' : 'manual',
        checkedAt: nowIso(),
        matches: match.matched,
        ratio: match.ratio ?? null,
        statusCode: result.statusCode,
        truncated: result.truncated,
      },
    }
  }
}
