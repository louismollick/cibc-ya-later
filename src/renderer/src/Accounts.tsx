import type { AppState } from '../../shared/types'
import { money } from './lib/format'
import { PaneHead } from './Shell'

export function Accounts({ state }: { state: AppState }) {
  return (
    <>
      <PaneHead title="Accounts" />
      {state.accounts.length ? (
        <ul className="rows">
          {state.accounts.map((a) => (
            <li key={a.id}>
              <div>
                {a.name}
                <small>
                  {a.last4}
                  {a.currency !== 'CAD' && ` · ${a.currency}`}
                </small>
              </div>
              <span className="amount">{money(a.balance, a.currency)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No accounts yet.</p>
      )}
    </>
  )
}
