import type { Settings } from '../shared/types'
// Calendar arithmetic follows the Mac's local timezone, including DST. A spring
// clock jump normalizes a nonexistent time forward; a fall repeat runs once.
export function scheduleWindow(schedule: Settings['schedule'], now = new Date()) {
  const [hour, minute] = schedule.time.split(':').map(Number)
  let previous: number | null = null,
    next: number | null = null
  for (let offset = -7; offset <= 7; offset++) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(hour ?? 0, minute ?? 0, 0, 0)
    if (!schedule.weekdays.includes(candidate.getDay())) continue
    const timestamp = Math.floor(candidate.getTime() / 1000)
    if (candidate <= now) previous = Math.max(previous ?? 0, timestamp)
    else next = Math.min(next ?? Number.POSITIVE_INFINITY, timestamp)
  }
  return { previous, next }
}
