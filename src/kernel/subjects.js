/**
 * Subject identity primitives (review B1/B2).
 *
 * A subject is not its stock code and not its display name:
 *  - `entityId`      stable internal key (persisted; used as artifact subjectId for v2 projects)
 *  - `identifiers[]` external, typed, verifiable attributes (USCC / registry no / ticker / AMAC ...)
 *  - `listingStatus` independent enum, default `unknown` — never inferred from a code
 *
 * Legacy `code` survives only as a read-only display mirror for templates.
 */

import { slugify, stableId, subjectIdFor } from '../util/ids.js'

/**
 * Identifier schemes we render with a label. Unknown schemes are preserved
 * verbatim (the layer must stay extensible), they are just not prettified.
 */
export const IDENTIFIER_SCHEME_LABELS = Object.freeze({
  CN_USCC: '统一社会信用代码',
  CN_LEGACY_REG_NO: '工商注册号',
  SECURITY_TICKER: '证券代码',
  HK_CR_NO: '香港公司编号',
  SG_UEN: '新加坡 UEN',
  US_STATE_FILE_NO: '美国州注册号',
  SEC_CIK: 'SEC CIK',
  LEI: 'LEI',
  KY_REG_NO: '开曼注册号',
  BVI_NO: 'BVI 注册号',
  AMAC_MANAGER_NO: '中基协管理人登记编号',
  AMAC_FUND_NO: '中基协基金备案编码',
  UNTYPED_EXTERNAL_IDENTIFIER: '未分类外部标识',
  INTERNAL_PROVISIONAL: '内部临时标识',
})

/** Schemes that identify an entity (as opposed to one security it issued). */
export const ENTITY_KEY_SCHEMES = Object.freeze([
  'CN_USCC',
  'CN_LEGACY_REG_NO',
  'HK_CR_NO',
  'SG_UEN',
  'US_STATE_FILE_NO',
  'SEC_CIK',
  'LEI',
  'KY_REG_NO',
  'BVI_NO',
  'AMAC_MANAGER_NO',
  'AMAC_FUND_NO',
])

/** Preferred primary order when no identifier is explicitly flagged `isPrimary`. */
const PRIMARY_PRIORITY = Object.freeze([
  'CN_USCC',
  'CN_LEGACY_REG_NO',
  'HK_CR_NO',
  'SG_UEN',
  'KY_REG_NO',
  'BVI_NO',
  'LEI',
  'US_STATE_FILE_NO',
  'SEC_CIK',
  'AMAC_MANAGER_NO',
  'AMAC_FUND_NO',
  'SECURITY_TICKER',
])

const SCHEME_ALIASES = Object.freeze({
  '统一社会信用代码': 'CN_USCC',
  统一社会信用代码: 'CN_USCC',
  uscc: 'CN_USCC',
  credit_code: 'CN_USCC',
  '工商注册号': 'CN_LEGACY_REG_NO',
  注册号: 'CN_LEGACY_REG_NO',
  reg_no: 'CN_LEGACY_REG_NO',
  '证券代码': 'SECURITY_TICKER',
  '股票代码': 'SECURITY_TICKER',
  ticker: 'SECURITY_TICKER',
  stock_code: 'SECURITY_TICKER',
  '中基协基金备案编码': 'AMAC_FUND_NO',
  '基金备案编码': 'AMAC_FUND_NO',
  '中基协管理人登记编号': 'AMAC_MANAGER_NO',
  '管理人登记编号': 'AMAC_MANAGER_NO',
})

/** `verificationStatus` accepts the evidence-ledger vocabulary plus a default. */
export const IDENTIFIER_VERIFICATION_STATUSES = Object.freeze(['unverified', 'partial', 'verified', 'unreachable', 'conflict'])

export const LISTING_STATUSES = Object.freeze(['unknown', 'unlisted', 'ipo_applied', 'listed', 'suspended', 'delisted', 'not_applicable'])

/**
 * Statuses for which a public-company financial disclosure requirement does
 * not exist. `unknown` is deliberately included: absent evidence, a subject
 * must not be treated as a listed issuer.
 */
export const NON_PUBLIC_LISTING_STATUSES = Object.freeze(['unlisted', 'ipo_applied', 'unknown', 'not_applicable'])

/** Statuses that carry a public disclosure obligation (current or historical). */
export const PUBLIC_LISTING_STATUSES = Object.freeze(['listed', 'suspended', 'delisted'])

const LISTING_ALIASES = Object.freeze({
  '上市': 'listed',
  '已上市': 'listed',
  '上市公司': 'listed',
  '未上市': 'unlisted',
  '非上市': 'unlisted',
  '非公众公司': 'unlisted',
  '拟ipo': 'ipo_applied',
  '拟上市': 'ipo_applied',
  'ipo申报': 'ipo_applied',
  '停牌': 'suspended',
  '暂停上市': 'suspended',
  '退市': 'delisted',
  '已退市': 'delisted',
  '不适用': 'not_applicable',
  'unknown': 'unknown',
  '未知': 'unknown',
})

/* ------------------------------------------------------------------ */
/* USCC                                                                */
/* ------------------------------------------------------------------ */

// GB 32100-2015 charset: digits + A-Z minus I, O, S, V, Z (31 symbols).
const USCC_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY'
const USCC_WEIGHTS = Object.freeze([1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28])

/** Compute the GB 32100-2015 check character for the first 17 symbols. */
export function usccCheckChar(first17) {
  const text = String(first17 ?? '').trim().toUpperCase()
  if (!/^[0-9A-HJ-NPQRTUWXY]{17}$/.test(text)) return null
  let sum = 0
  for (let index = 0; index < 17; index += 1) {
    const value = USCC_CHARSET.indexOf(text[index])
    if (value < 0) return null
    sum += value * USCC_WEIGHTS[index]
  }
  let check = 31 - (sum % 31)
  if (check === 31) check = 0
  return USCC_CHARSET[check]
}

/**
 * Optional checksum check. A valid checksum is necessary, not sufficient:
 * it never promotes an identifier to `verified` on its own.
 */
export function isValidUscc(value) {
  const text = String(value ?? '').trim().toUpperCase()
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(text)) return false
  return usccCheckChar(text.slice(0, 17)) === text[17]
}

/**
 * Classify a legacy free-form `code` by shape. This is deliberately only a
 * classification — it never infers `listingStatus`; a 6-digit security ticker
 * still has `listingStatus: unknown` until evidence says otherwise.
 */
export function classifyIdentifier(raw, { jurisdiction = 'CN' } = {}) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const upper = value.toUpperCase()
  if (/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(upper)) {
    return {
      scheme: 'CN_USCC',
      value: upper,
      issuer: '市场监管',
      jurisdiction: 'CN',
      verificationStatus: 'unverified',
      checksum: isValidUscc(upper) ? 'valid' : 'invalid',
    }
  }
  if (/^\d{6}$/.test(value)) {
    return { scheme: 'SECURITY_TICKER', value, issuer: '', jurisdiction, verificationStatus: 'unverified' }
  }
  if (/^[A-Z0-9]{15}$/.test(upper)) {
    return { scheme: 'CN_LEGACY_REG_NO', value: upper, issuer: '市场监管', jurisdiction: 'CN', verificationStatus: 'unverified' }
  }
  return { scheme: 'UNTYPED_EXTERNAL_IDENTIFIER', value, issuer: '', jurisdiction, verificationStatus: 'unverified' }
}

/* ------------------------------------------------------------------ */
/* listingStatus                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normalize a listing status. Anything absent or unrecognised becomes
 * `unknown`. This function never looks at identifiers/codes.
 */
export function normalizeListingStatus(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return 'unknown'
  const alias = LISTING_ALIASES[text]
  if (alias) return alias
  return LISTING_STATUSES.includes(text) ? text : 'unknown'
}

export function isNonPublicListingStatus(value) {
  return NON_PUBLIC_LISTING_STATUSES.includes(normalizeListingStatus(value))
}

export function isPublicListingStatus(value) {
  return PUBLIC_LISTING_STATUSES.includes(normalizeListingStatus(value))
}

/* ------------------------------------------------------------------ */
/* identifiers                                                         */
/* ------------------------------------------------------------------ */

function normalizeScheme(scheme) {
  const raw = String(scheme ?? '').trim()
  if (!raw) return null
  const alias = SCHEME_ALIASES[raw] ?? SCHEME_ALIASES[raw.toLowerCase()]
  if (alias) return alias
  // Canonical uppercase snake-case without guessing a scheme for plain values.
  return raw.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_').replaceAll(/^_+|_+$/g, '') || null
}

function normalizeIdentifierValue(scheme, value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (scheme === 'CN_USCC' || scheme === 'SECURITY_TICKER') {
    return text.replaceAll(/\s+/g, '').toUpperCase()
  }
  return text
}

function normalizeVerificationStatus(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return IDENTIFIER_VERIFICATION_STATUSES.includes(text) ? text : 'unverified'
}

/**
 * Normalize one identifier. Accepts `scheme` (preferred) or legacy `kind`
 * labels, plus `issuer`/`authority`, `jurisdiction`, `verificationStatus`/`status`.
 * A bare string becomes `UNTYPED_EXTERNAL_IDENTIFIER` — we do not guess a scheme.
 */
export function normalizeIdentifier(input, defaults = {}) {
  const source = typeof input === 'string' ? { value: input, scheme: 'UNTYPED_EXTERNAL_IDENTIFIER' } : (input ?? {})
  const scheme = normalizeScheme(source.scheme ?? source.kind ?? source.type) ?? 'UNTYPED_EXTERNAL_IDENTIFIER'
  const value = normalizeIdentifierValue(scheme, source.value ?? source.normalizedValue)
  if (!value) return null
  const out = {
    scheme,
    value,
    issuer: String(source.issuer ?? source.authority ?? '').trim(),
    jurisdiction: String(source.jurisdiction ?? defaults.jurisdiction ?? 'CN').trim().toUpperCase() || 'CN',
    verificationStatus: normalizeVerificationStatus(source.verificationStatus ?? source.status),
  }
  if (source.isPrimary === true) out.isPrimary = true
  if (scheme === 'CN_USCC') out.checksum = isValidUscc(value) ? 'valid' : 'invalid'
  if (source.note) out.note = String(source.note)
  return out
}

/** Normalize an identifier list, dropping empties and exact duplicates. */
export function normalizeIdentifiers(list, defaults = {}) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  let primarySeen = false
  for (const item of list) {
    const identifier = normalizeIdentifier(item, defaults)
    if (!identifier) continue
    const key = `${identifier.scheme}:${identifier.value}`.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (identifier.isPrimary === true) {
      if (primarySeen) delete identifier.isPrimary
      else primarySeen = true
    }
    out.push(identifier)
  }
  return out
}

function schemeRank(scheme) {
  const index = PRIMARY_PRIORITY.indexOf(scheme)
  return index < 0 ? PRIMARY_PRIORITY.length : index
}

/** Primary identifier: explicit `isPrimary` wins, otherwise scheme priority. */
export function primaryIdentifier(identifiers) {
  const list = Array.isArray(identifiers) ? identifiers.filter((item) => item?.value) : []
  if (list.length === 0) return null
  return list.find((item) => item.isPrimary === true) ?? [...list].sort((a, b) => schemeRank(a.scheme) - schemeRank(b.scheme))[0]
}

/** Identifier used to seed `entityId` — entity-level schemes only (never a security ticker). */
export function entityKeyIdentifier(identifiers) {
  const list = Array.isArray(identifiers) ? identifiers.filter((item) => item?.value) : []
  const entityLevel = list.filter((item) => ENTITY_KEY_SCHEMES.includes(item.scheme))
  return primaryIdentifier(entityLevel)
}

/** Human-readable identifier list for prompt variables. */
export function formatIdentifiers(identifiers) {
  const list = Array.isArray(identifiers) ? identifiers : []
  return list
    .map((item) => {
      const label = IDENTIFIER_SCHEME_LABELS[item.scheme] ?? item.scheme
      const parts = [`${label} ${item.value}`]
      const meta = [item.issuer, item.jurisdiction, item.verificationStatus].filter((value) => value && value !== 'unverified')
      if (meta.length > 0) parts.push(`（${meta.join('；')}）`)
      return parts.join('')
    })
    .join('\n')
}

/* ------------------------------------------------------------------ */
/* entityId                                                            */
/* ------------------------------------------------------------------ */

function normalizeName(name) {
  return String(name ?? '').normalize('NFKC').replaceAll(/\s+/g, ' ').trim()
}

/**
 * Stable internal entity id.
 *
 * Seed order:
 *   1. entity-level primary identifier (USCC/registry no/LEI/AMAC ...) — `co_<hash>`
 *   2. jurisdiction + normalized name — legacy-compatible slug (`co_<slug>`, `_hk` suffix off-CN)
 *
 * Persist the value on the target: a name-seeded id is only stable for as long
 * as the name is not corrected, so callers must not recompute it after creation.
 */
export function entityIdFor({ name, jurisdiction = 'CN', identifiers = [] } = {}) {
  const keyIdentifier = entityKeyIdentifier(identifiers)
  if (keyIdentifier) return stableId('co', `identifier:${keyIdentifier.scheme}:${keyIdentifier.value.toUpperCase()}`)
  const slug = slugify(normalizeName(name), 'unknown')
  const region = String(jurisdiction ?? 'CN').trim().toUpperCase()
  return region && region !== 'CN' ? `co_${slug}_${slugify(region)}` : `co_${slug}`
}

/* ------------------------------------------------------------------ */
/* targets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Normalize one project target.
 *
 * `name` is the immutable *input* name (search string); the legal name learned
 * by entity-resolution is written to the roster `_resolution` partition and
 * surfaced through `company.name`, never by rewriting this field.
 */
export function normalizeTarget(input, defaults = {}) {
  const source = typeof input === 'string' ? { name: input } : (input ?? {})
  const name = normalizeName(source.name ?? source.inputName)
  if (!name) return null
  const jurisdiction = String(source.jurisdiction ?? defaults.jurisdiction ?? 'CN').trim().toUpperCase() || 'CN'
  const code = source.code === undefined || source.code === null ? '' : String(source.code).trim()
  let identifiers = normalizeIdentifiers(source.identifiers, { jurisdiction })
  if (identifiers.length === 0 && code) {
    identifiers = normalizeIdentifiers([classifyIdentifier(code, { jurisdiction })], { jurisdiction })
  }
  const listingStatus = normalizeListingStatus(source.listingStatus ?? defaults.listingStatus)
  const target = {
    name,
    inputName: normalizeName(source.inputName) || name,
    type: String(source.type ?? defaults.type ?? 'corporate'),
    jurisdiction,
    status: String(source.status ?? 'target'),
    entityId: String(source.entityId ?? '').trim() || entityIdFor({ name, jurisdiction, identifiers }),
    identifiers,
    listingStatus,
  }
  if (code) target.code = code
  if (source.market) target.market = String(source.market).trim()
  return target
}

/**
 * Subject key for a target. v2 projects use the persisted `entityId`; v1
 * projects keep the legacy `co_<slug>` key so existing artifacts are not re-keyed.
 */
export function subjectIdForTarget(target, project = null) {
  const version = Number(project?.schemaVersion ?? 0)
  if (version >= 2 && target?.entityId) return String(target.entityId)
  return subjectIdFor('co', target?.name ?? 'unknown')
}

/** Does `subjectId` denote this target (v1 legacy key or v2 entityId)? */
export function matchesSubjectId(target, subjectId) {
  if (!target || !subjectId) return false
  const text = String(subjectId)
  if (target.entityId && text === String(target.entityId)) return true
  if (text === subjectIdFor('co', target.name ?? 'unknown')) return true
  if (target.inputName && text === subjectIdFor('co', target.inputName)) return true
  return false
}
