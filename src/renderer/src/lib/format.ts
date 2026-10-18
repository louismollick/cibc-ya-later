// Display helpers. Times follow the Mac's locale and timezone.

const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

// "7:02 AM", "yesterday 7:01 AM", or "Oct 3".
export function when(seconds: number) {
  const d = new Date(seconds * 1000)
  const now = new Date()
  if (sameDay(d, now)) return time(d)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return `yesterday ${time(d)}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// "Sat 7:00 AM", for the next scheduled sync.
export function upcoming(seconds: number) {
  const d = new Date(seconds * 1000)
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time(d)}`
}

// "just now", "12 min ago", "3 h ago", "4 d ago".
export function ago(seconds: number, now = Date.now() / 1000) {
  const minutes = Math.floor((now - seconds) / 60)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} d ago`
}

// "2:14" for a countdown in seconds.
export function countdown(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Canadian formatting, so CAD reads "$1.00" and USD reads "US$1.00".
export function money(value: string, currency: string) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(Number(value))
}

export function day(seconds: number) {
  const d = new Date(seconds * 1000)
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
}
