import { z } from 'zod'

export { validBaseUrl } from '../shared/urls'
export const settingsSchema = z.object({
  schedule: z.object({
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }),
  launchAtLogin: z.boolean(),
})
export const credentialsSchema = z
  .object({
    card: z
      .string()
      .trim()
      .regex(/^\d{13,19}$/),
    password: z.string().min(1).max(256),
  })
  .strict()
export const codeSchema = z.string().regex(/^\d{6,8}$/)
export const labelSchema = z.string().trim().min(1).max(60)
export function accountQuery(params: URLSearchParams) {
  function date(key: string) {
    const values = params.getAll(key)
    if (values.length > 1) throw new Error(`Repeat ${key} is not allowed.`)
    const v = values[0]
    if (v === undefined) return undefined
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > 253402300799)
      throw new Error(`Invalid ${key}. Use Unix seconds.`)
    return Number(v)
  }
  const start = date('start-date'),
    end = date('end-date')
  if (start !== undefined && end !== undefined && start >= end)
    throw new Error('start-date must be before end-date.')
  for (const key of ['pending', 'balances-only'])
    if (
      params.has(key) &&
      (params.getAll(key).length !== 1 || !['0', '1'].includes(params.get(key) ?? ''))
    )
      throw new Error(`Invalid ${key}.`)
  const accounts = params.getAll('account')
  if (accounts.length > 100 || accounts.some((a) => !a || a.length > 128))
    throw new Error('Invalid account filter.')
  return {
    start,
    end,
    accounts,
    pending: params.get('pending') === '1',
    balancesOnly: params.get('balances-only') === '1',
  }
}
