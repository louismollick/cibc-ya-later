import type { DownloadedAccount } from '../src/shared/types'
export const sampleAccount = (id = 'account-a'): DownloadedAccount => ({
  id,
  sourceId: `bank-${id}`,
  name: 'Chequing',
  currency: 'CAD',
  balance: '1200.25',
  balanceDate: 1792108800,
  coverageStart: 1791676800,
  coverageEnd: 1792281600,
  transactions: [
    {
      id: `${id}-one`,
      posted: 1791763200,
      amount: '-10.25',
      description: 'Grocery',
      pending: false,
    },
    {
      id: `${id}-two`,
      posted: 1791849600,
      amount: '100.00',
      description: 'Deposit',
      pending: false,
    },
    {
      id: `${id}-pending`,
      posted: 1791936000,
      amount: '-5.00',
      description: 'Pending',
      pending: true,
    },
  ],
})
export function ofx({
  credit = false,
  transactions = true,
}: {
  credit?: boolean
  transactions?: boolean
} = {}) {
  const tag = credit ? 'CCSTMTRS' : 'STMTRS'
  return Buffer.from(
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nENCODING:USASCII\nCHARSET:1252\n\n<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS></SONRS></SIGNONMSGSRSV1><${tag}><STATUS><CODE>0<SEVERITY>INFO</STATUS><CURDEF>CAD<${credit ? 'CCACCTFROM' : 'BANKACCTFROM'}>${credit ? '' : '<BANKID>010'}<ACCTID>12345 12-34567</${credit ? 'CCACCTFROM' : 'BANKACCTFROM'}><BANKTRANLIST><DTSTART>20261001120000<DTEND>20261015120000${transactions ? '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261010120000<TRNAMT>-12.34<FITID>abc-123<NAME>GROCERY &amp; MORE<MEMO>Purchase</STMTTRN><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261011120000<TRNAMT>100.00<FITID>abc-124<NAME>TRANSFER</STMTTRN>' : ''}</BANKTRANLIST><LEDGERBAL><BALAMT>1200.25<DTASOF>20261016120000[-4:EDT]</LEDGERBAL></${tag}></OFX>`,
  )
}

// Codex runs commands under a macOS sandbox that aborts Chrome on launch, which
// pops a "quit unexpectedly" dialog per process. Real-browser tests skip there.
export const sandboxed = Boolean(process.env.CODEX_SANDBOX)
