# CIBC Ya Later

Downloads CIBC's official transaction exports on a Mac and serves them to budgeting apps through a SimpleFIN-compatible API.

## Language

### Bank side

**Sync**:
One unattended run that signs in to CIBC, downloads every account's recent export, and replaces the snapshot only if everything verifies.
_Avoid_: Refresh, download, reconnect

**Full history download**:
A one-time sync that uses CIBC's "All available" export instead of the recent window. Offered once at sign-in if it has never completed.
_Avoid_: Backfill (in the UI)

**Sign in**:
Saving CIBC card number and password on this Mac. Happens once; the form only returns after Sign out or when CIBC rejects the password.
_Avoid_: Connect CIBC, Reconnect

**Sign out**:
Forgetting the saved CIBC credentials and browser session. Cached accounts, apps, and settings stay.

**Code relay**:
The iPhone Shortcut that forwards CIBC's verification code to the Mac during a sync.
_Avoid_: MFA relay, OTP relay

**Code fallback**:
Typing the verification code into the app by hand. Offered only when the code relay has not delivered within its window.

**Closed account**:
An account CIBC no longer lists that the owner has confirmed as closed. Its history is kept and it no longer blocks syncs.
_Avoid_: Retired account

### Consumer side

**App**:
A budgeting app (Sure, Actual) with its own read-only access. It only reads the cached snapshot and never triggers a Sync.
_Avoid_: Client (in the UI)

**Setup token**:
A one-time, 15-minute token an app claims to receive its access.
