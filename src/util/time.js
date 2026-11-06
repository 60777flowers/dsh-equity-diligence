/** Time helpers shared by the kernel, tools and builders. */

/** Current timestamp as ISO-8601 with the local numeric offset. */
export function nowIso(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** Today in local time as YYYY-MM-DD. */
export function today(date = new Date()) {
  return nowIso(date).slice(0, 10)
}

/** Parse a date-like value; returns null when invalid. */
export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00`)
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

/** True for a valid YYYY-MM-DD date string. */
export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = parseDate(value)
  return date !== null && date.toISOString().slice(0, 10) === value
}

/** Whole days between two dates (to - from); null when invalid. */
export function daysBetween(from, to) {
  const a = parseDate(from)
  const b = parseDate(to)
  if (!a || !b) return null
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000)
}

/** Add days to a date-like value and return YYYY-MM-DD. */
export function addDays(value, days) {
  const date = parseDate(value)
  if (!date) return null
  const next = new Date(date.getTime() + days * 86_400_000)
  return next.toISOString().slice(0, 10)
}

/** A compact local timestamp suitable for file names. */
export function fileStamp(date = new Date()) {
  return nowIso(date).replaceAll(':', '').replaceAll('-', '').slice(0, 15)
}
