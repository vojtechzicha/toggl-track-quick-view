# Sign Bridge

A Chrome extension and a macOS native host that let the web app sign with the
qualified certificate on the I.CA card. Code lives in the sibling repository
`../zicha-sign-bridge`; the wire protocol is specified there in
`protocol/protocol.md`. Why neither Fortify nor I.CA's own component is used: see
[pdf-signing-v2.md → Alternatives considered](pdf-signing-v2.md#alternatives-considered).

## Status (2026-08-27)

| Phase | State |
|---|---|
| 1. Host talks to a token (Swift, PKCS#11, SoftHSM tests, CI) | Done |
| 2. Protocol, native host, extension with pinned id, `dev-install.sh` | Done |
| 3. The real card | Done. A timesheet was signed from `localhost:3000` with the qualified certificate. |
| 4. UI and packaging | Open |
| 5. Deploy | Open |
| 6. Firefox | Later |

**Phase 4, UI and packaging.** Pairing, PIN and confirmation windows; a `.pkg`;
`release.yml` with Developer ID signing, notarization, stapling and a GitHub Release.
Done when a fresh Mac installs from the release and signs.

**Phase 5, deploy.** Extension published (see [Distribution](#distribution-planned)),
`track.zicha.dev` added to `externally_connectable`. Done when signing works from the
deployed app. The app-side readiness UI is already shipped.

**Phase 6, Firefox.** Firefox has no `externally_connectable`. I.CA's own client
works around that with a content script that injects `window.csConnectExtension`;
that is a second transport to build and test.

## Why an extension and a native host

I.CA's native-messaging host pins `allowed_origins` to eleven of its own extension
IDs, so an extension of ours cannot use their host. Owning the extension means owning
the native side too. Given that, native messaging beats a localhost HTTP helper:

| | Extension + native messaging | Localhost HTTP helper |
|---|---|---|
| Attack surface | No listening port. The browser spawns the host over stdio. | A port any local process or page can reach. |
| Origin control | `externally_connectable.matches`, enforced by the browser. | Our own `Origin` check, which a non-browser caller can omit. |
| Mixed content / LNA | Not applicable. | Chrome's Local Network Access prompt; Safari refuses. |
| Install detection | A port to a missing extension disconnects at once, so the page knows what to offer. | A failed fetch, indistinguishable from "helper busy". |
| Cost | A store listing or a policy install. | None. |

A daemon that signs arbitrary bytes with a QES key must not be reachable by anything
that can open a socket.

Scope:

- macOS only. The card is on a Mac. The protocol is portable; only the host would
  need rewriting.
- Chrome and Edge first. Firefox is phase 6. Safari never (no native messaging for
  web pages).
- Signs what our app asks it to sign. Not a general signing product.

## Architecture

```
  track.zicha.dev (or localhost:3000)
    │  chrome.runtime.connect(EXTENSION_ID)      ← browser enforces externally_connectable
    ▼
  Sign Bridge extension  (MV3 service worker)
    │  chrome.runtime.connectNative('dev.zicha.signbridge')
    ▼
  signbridge-host        (Swift, one process per connection)
    │  dlopen + PKCS#11
    ▼
  libICASecureStorePkcs11.dylib → ACR40T → ICA Starcos 3.74
```

The host opens and closes a PKCS#11 session around each operation, and the PIN
authorises exactly one signature. The original plan put a small stdio shim in front
of a long-lived menu-bar agent that owns the card, so that two tabs never hold two
sessions on one card and there is somewhere to keep pairing state. That split is
deferred until a card objects to two processes. The protocol does not change either
way.

**Exit ordering.** With SecureStore loaded the host used to hang forever inside
`exit()` while holding the card. The dylib's destructor
(`HearbeatThreadGuard::~HearbeatThreadGuard`, run from `__cxa_finalize_ranges`) joins
a heartbeat thread that only `C_Finalize` stops, and `exit` (including returning from
`main`) runs that destructor. The host calls `PKCS11Module.finalize()` and then leaves
by `_exit`, which runs no destructors. That is its only exit path.

## Protocol, as the app uses it

`lib/export/pdf/sign/extensionBridge.ts` implements `TokenBridge` over one port per
bridge. Every request carries `id` and `protocol: 1`; replies echo the `id`.

| Request | Reply |
|---|---|
| `hello` | `ok`, `hostVersion`, `paired`, `tokens: [{label, serial}]`. On failure `code` is `helper_missing` or `helper_outdated` (with `have` and `need`). Must be silent: no window, no PIN. |
| `pair` | `ok`, `paired`. While the host's approval window is open it sends an event frame `{event: 'pairing-code', code}`, which the dialog shows so the user can compare. |
| `listCertificates` | `certificates: [{id, der, hasPrivateKey, tokenLabel, tokenSerial}]`. Raw DER only; the app parses it (`certificateInfo.ts`) so there is one answer to "is this a QES", pinned by `check:signature`. |
| `sign` | `{certificateId, hash: 'SHA-256', data, context: {documentName, digest}}` → `signature`. The host refuses a request without `context`. |

Base64 for all binary fields. Error codes the app turns into messages: `refused`,
`pin_failed`, `pin_locked`, `no_private_key`, `no_token`, `not_paired`.

`context` is shown in the host's confirmation window. `digest` is SHA-256 over
`data`, so what the window shows is tied to the bytes being signed rather than to
what the page claims.

A `certificateChain` request was specified but is not implemented in the host. The
card carries its issuer's CA certificates, so the app builds the chain from the list
it already has (see pdf-signing-v2.md → The issuing chain).

## Security model

Four independent layers:

1. **Origin, enforced by the browser.** `externally_connectable.matches` lists our
   origins only. Page script cannot forge the origin the extension sees.
2. **Extension identity, enforced by the browser.** The native host manifest's
   `allowed_origins` names our extension ID only.
3. **Pairing, once per origin.** First contact puts a code in the host's window and
   the page shows the same code; approving stores the origin. Revocation from a
   menu-bar UI is part of phase 4.
4. **The PIN is the consent.** `C_Login` per signature, with the PIN typed into the
   host's own window, never the browser, next to the document name and digest.

Excluded by design: remembering the PIN, any unattended mode, and any API that signs
without the confirmation window.

## Detection and the install prompt

`TokenBridge.readiness()` returns a `BridgeReadiness` state, because the fix differs
for each. It must be silent, since it runs as soon as signing is switched on.

| State | How it is detected |
|---|---|
| `unsupported` | No `chrome.runtime.connect` (Safari, Firefox, mobile), or an unrecognised `hello` failure. |
| `extension-missing` | The port to `SIGN_BRIDGE_EXTENSION_ID` disconnects with `lastError`. |
| `helper-missing` / `helper-outdated` | The extension answers `hello` even when `connectNative` fails, and says which. The required host version is a constant in the extension, so they ship together. |
| `no-token` | `hello` reports no tokens (reader empty). |
| `not-paired` | `hello` reports `paired: false`. |

`isAvailable()` is true for `ready` and `not-paired`: pairing is the next step, not a
reason to hide the option. The export dialog shows each other state as one sentence
and a link, where the certificate picker would be.

Both install links currently point at the GitHub Releases page.

## Repository and build

- Swift throughout: the AppKit dialogs are most of the work, PKCS#11 is C interop
  either way, and universal binaries, hardened runtime and notarization are
  first-class.
- Bundle id and native host name `dev.zicha.signbridge`.
- **The extension ID is pinned** with a `key` in `manifest.json` (public half of a
  keypair generated once). Without it the unpacked and published builds get different
  IDs, and the ID appears in the app (`SIGN_BRIDGE_EXTENSION_ID`), the host manifest's
  `allowed_origins`, and any policy install. The sibling repo's `check-manifest.mjs`
  derives the ID from the key and checks every copy.
- The keypair is never rotated; losing it means a new extension ID and a reinstall
  everywhere. Keep it in 1Password next to the CI item.

## Distribution (planned)

**Host.** GitHub Releases: a universal `.pkg`, Developer ID signed, notarized and
stapled, installing to `/Applications` plus a per-user native-host manifest (no
admin). The extension links to `…/releases/latest/download/SignBridge.pkg`, so the
page never calls the GitHub API.

**Extension**, one of:

- **Chrome Web Store, unlisted** (preferred). $5 once, reachable by link only,
  auto-updates. Edge installs Chrome Web Store extensions, so one listing covers both.
- **Self-hosted CRX under enterprise policy.** Chrome on macOS only allows off-store
  installs through managed policy: a `com.google.Chrome` policy with
  `ExtensionSettings → installation_mode: normal_installed` and an `update_url`
  pointing at `updates.xml` on GitHub Pages. No review, but a one-time policy install
  per machine. The fallback if store review objects to a signing extension.

Both can come from the same CI job.

## Testing

- **Host unit tests against SoftHSM** (`brew install softhsm`), in CI on a macOS
  runner: enumeration, `C_Login` failures, and signing through a DigestInfo built by
  the host with raw `CKM_RSA_PKCS` (the card has no `CKM_SHA256_RSA_PKCS`), verified
  against the certificate's public key. The module path is configuration, so the same
  binary talks to SoftHSM and SecureStore.
- **Protocol conformance**: `protocol.schema.json` validated from both sides.
- **This repo**: `check:signature` covers the bridge order, `readiness()` outside a
  browser, and the chain walk. A fake extension transport running the full PAdES
  assertions over the real protocol shape was planned and is not built. The DSS
  validator remains the manual milestone check.

## Prerequisites for phase 4

- **Apple Developer Program** ($99/yr) for Developer ID signing and notarization.
  Without it, installing needs right-click → Open past Gatekeeper.
- **`com.apple.security.cs.disable-library-validation`** on the host's entitlements,
  so it can `dlopen` SecureStore's module. Fortify lacked this and macOS killed it.
- **Chrome Web Store account** ($5) for the store route.
- CI secrets in 1Password vault `Development`, item `zicha-sign-bridge-ci`:
  `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_TEAM_ID`, `ASC_KEY_ID`,
  `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`, plus store credentials if used.
