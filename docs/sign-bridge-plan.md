# Sign Bridge — plan

A browser extension and a macOS helper that let a web page sign with the qualified
certificate on the I.CA token, replacing Fortify (dead — see `pdf-signing-v2.md`) and
I.CA's PKIServiceHost (unusable off `localhost` without a licence).

Status: **phases 1–3 built** (2026-08-22), in `../zicha-sign-bridge`. The agent signs
against SoftHSM and enumerates the real I.CA card; the extension, the native host and
the protocol between them are written and checked; the app has its bridge and its
readiness UI. Not yet done: loading the extension into Chrome for a true end-to-end
run, the menu-bar UI, packaging and release (phase 4), and publishing (phase 5).

## What forces the shape

A custom extension cannot reuse I.CA's helper. Their native-messaging host manifest
pins `allowed_origins` to eleven extension IDs, so an extension we build is refused by
their binary no matter what it sends. Owning the extension therefore means owning the
native side too. That is the whole scope of this document.

Given that we are building the native side anyway, the extension earns its place by
being the better transport:

| | Extension + native messaging | Localhost HTTP helper |
|---|---|---|
| Attack surface | **No listening port at all.** The browser spawns the helper over stdio. | A port any local process or page can reach. |
| Origin control | `externally_connectable.matches` — enforced by the browser, before our code runs. | Our own `Origin` check, which a non-browser caller simply omits. |
| Mixed content / LNA | Not applicable. | Chrome's Local Network Access prompt; Safari refuses outright. |
| Install & detect | `chrome.runtime.sendMessage(id)` fails cleanly when absent → the page knows exactly what to offer. | A failed fetch, indistinguishable from "helper busy". |
| Cost | A store listing, or a policy install. | None. |

The port is the deciding line. A daemon that signs arbitrary bytes with a QES key must
not be reachable by anything that can open a socket.

## Non-goals

- **macOS only.** The card is on a Mac; nothing else needs solving. The protocol is
  portable, and the helper is the only piece that would need rewriting.
- **Chrome and Edge first.** Firefox has no `externally_connectable` — I.CA's own client
  falls back to a content script injecting `window.csConnectExtension`, which is a second
  transport to build and test. Deferred, not designed out: see "Phase 5".
- **Safari never.** No native messaging for web pages.
- Not a general signing product. It signs what our app asks it to sign.

## Architecture

```
  track.zicha.dev (or localhost:3000)
    │  chrome.runtime.connect(EXTENSION_ID)      ← browser enforces externally_connectable
    ▼
  Sign Bridge extension  (MV3 service worker, ~200 lines)
    │  chrome.runtime.connectNative('dev.zicha.signbridge')
    ▼
  signbridge-shim        (stdio, tiny)           ← what Chrome actually launches
    │  unix socket ~/Library/Application Support/SignBridge/agent.sock
    ▼
  SignBridge.app         (menu-bar agent, owns the card and the UI)
    │  dlopen + PKCS#11
    ▼
  libICASecureStorePkcs11.dylib → ACR40T → ICA Starcos 3.74
```

**Why a shim and an agent rather than one process.** Chrome launches a native messaging
host per connection. One process per tab means several PKCS#11 sessions against one card,
and a card that permits one session at a time turns a second tab into a mystery failure.
It also means no place to keep a PIN session or a pairing decision. The agent is a single
owner of the card with a lifetime longer than a tab; the shim is a pipe.

The shim is the only thing whose path appears in the native-host manifest, so the agent
can be updated, moved or restarted without re-registering anything.

## Protocol

One versioned JSON protocol, page → extension → shim → agent, deliberately shaped like
the `TokenBridge` interface the app already has (`lib/export/pdf/sign/tokenBridge.ts`) so
the app-side implementation is a translation and nothing more.

```
→ {id, type: "hello", protocol: 1}
← {id, ok: true, agentVersion: "1.2.0", protocol: 1,
   tokens: [{label, model, serial, hardware: true}]}

→ {id, type: "pair", origin: "https://track.zicha.dev"}
← {id, ok: true, code: "K7F2"}            // agent shows the same four characters
← {id, ok: true, paired: true}            // second frame, when the user approves

→ {id, type: "listCertificates"}
← {id, ok: true, certificates: [{id, subjectDN, issuerDN, notBefore, notAfter,
                                 der, qualified, keyUsage: ["nonRepudiation"]}]}

→ {id, type: "certificateChain", certificateId}
← {id, ok: true, chain: [der, …]}

→ {id, type: "sign", certificateId, hash: "SHA-256", data,
   context: {documentName: "Timesheet 2026-08.pdf", digest: "9f86d0…"}}
← {id, ok: true, signature}

← {id, ok: false, code: "not_paired" | "cancelled" | "pin_failed" | "no_token" | …,
   message: "…"}
```

`context` is not decoration. The agent's confirmation window shows the document name and
the digest, so what appears on screen is tied to what is being signed rather than to what
the page claims it is doing.

## Security model

Four layers, each independent of the others:

1. **Origin, enforced by the browser.** `externally_connectable.matches` lists our
   origins and nothing else. Page script cannot forge the origin the extension sees.
2. **Extension identity, enforced by the OS.** The native host manifest's
   `allowed_origins` names our extension ID only. This is the same mechanism that keeps
   us out of I.CA's helper, used in our favour.
3. **Pairing, per origin, once.** First contact from an origin puts a code in the agent's
   window; the page displays the same code; approving stores the origin. Revocable from
   the menu bar.
4. **The PIN is the consent.** `C_Login` per signature, entered in the agent's own
   window, never in the browser, alongside the document name and digest. A page can ask
   for a signature; only a person at the keyboard can produce one.

Deliberately excluded: any "remember the PIN" option, any headless/unattended mode, and
any API that signs without the confirmation window.

## Repository

New sibling repo `../zicha-sign-bridge`, public or private (nothing in it is secret; the
signing identity lives in CI secrets). Bundle id `dev.zicha.signbridge`.

```
zicha-sign-bridge/
├─ agent/                     Swift package — SignBridge.app (menu bar, PKCS#11, UI)
│  ├─ Sources/SignBridgeAgent/{PKCS11/, Protocol/, UI/, main.swift}
│  └─ Tests/                  against SoftHSM (see Testing)
├─ shim/                      Swift — stdio ↔ unix socket, ~150 lines
├─ extension/                 MV3: manifest.json, background.ts, build with esbuild
├─ protocol/                  protocol.md + protocol.schema.json (the contract)
├─ packaging/                 productbuild plist, entitlements, host manifests
├─ scripts/dev-install.sh     register the debug build with Chrome, no admin
└─ .github/workflows/{ci.yml,release.yml}
```

**Swift, not Go.** macOS-only means the AppKit dialogs (PIN, confirmation, pairing) are
the bulk of the work, and PKCS#11 is C interop either way. Universal binaries, hardened
runtime and notarization are all first-class.

**The extension ID must be pinned** with a `"key"` in `manifest.json` (the base64 public
key of a keypair generated once, private half in CI secrets). Without it the unpacked
development build and the published build have different IDs, and the ID is baked into
three places: the app's bridge, the host manifest's `allowed_origins`, and any policy
install. Pinning makes local testing and production the same wiring.

## Distribution

**The helper** — GitHub Releases. Universal `.pkg`, Developer ID signed, notarized and
stapled, installing to `/Applications` plus a per-user native-host manifest (no admin).
The stable URL `…/releases/latest/download/SignBridge.pkg` is baked into the extension,
so the page never calls the GitHub API and never needs a token or a rate limit.

**The extension** — two routes, both real:

- **Chrome Web Store, unlisted** (recommended). $5 once, reachable by link only, and
  auto-updates on every machine signed into the same profile. Edge installs Chrome Web
  Store extensions directly, so one listing covers both.
- **Self-hosted CRX under enterprise policy.** Chrome refuses off-store installs on
  macOS *except* via managed policy, so a `com.google.Chrome` policy with
  `ExtensionSettings → installation_mode: normal_installed` and an `update_url` pointing
  at a `updates.xml` on GitHub Pages installs and auto-updates it with no store at all.
  No review, no listing, full control — at the cost of a one-time policy install per
  machine. Worth taking if the store review objects to a signing extension.

Both are driven from the same CI job; the second is a fallback that costs one extra
workflow step (`updates.xml` + the CRX to Pages).

## Detection and the install prompt

The app must distinguish "no extension" from "no helper" from "helper too old", because
the fix differs each time. `TokenBridge` gains one method:

```ts
type BridgeReadiness =
  | { state: 'ready' }
  | { state: 'unsupported'; reason: string }                    // Safari, mobile
  | { state: 'extension-missing'; installUrl: string }
  | { state: 'helper-missing'; installUrl: string }
  | { state: 'helper-outdated'; have: string; need: string; installUrl: string }
  | { state: 'not-paired' }
  | { state: 'no-token'; reason: string };                      // reader empty

interface TokenBridge { readiness(): Promise<BridgeReadiness>; /* …as today… */ }
```

`isAvailable()` becomes `(await readiness()).state === 'ready'`, so nothing else changes.
How each state is reached:

- **extension-missing** — `chrome.runtime.sendMessage(EXTENSION_ID, {type:'hello'})` sets
  `chrome.runtime.lastError`. This is the only probe that runs unprompted, and it is
  silent and instant.
- **helper-missing / helper-outdated** — the extension answers `hello` even when
  `connectNative` fails, reporting which. The required version is a constant in the
  extension, so the two ship together and cannot disagree.
- **no-token** — agent reached, no card in the reader.

The export dialog renders each state as one sentence and one link, in the place the
certificate picker sits today. No modal, no nagging: signing is optional, so a missing
helper is an explanation, never an interruption.

## Testing

**SoftHSM is the test token.** `brew install softhsm` gives a real PKCS#11 module with a
real key and a real PIN, so the agent's entire path — enumerate, login, sign — is
exercised with no card, no reader, and no qualified certificate. It runs in CI on a
macOS runner, and it is how the helper gets tested long before the I.CA certificate
exists. The module path is configuration, so the same binary talks to SoftHSM in tests
and to SecureStore in production.

Three layers:

1. **Agent unit tests** against SoftHSM — enumeration, `C_Login` failure paths, and the
   one detail already known to matter: the token offers no `CKM_SHA256_RSA_PKCS`, so the
   helper builds the DigestInfo itself and signs with raw `CKM_RSA_PKCS`. A test asserts
   the produced signature verifies against the certificate's public key.
2. **Protocol conformance** — `protocol.schema.json` validated from both sides, so the
   extension and the agent cannot drift.
3. **End-to-end, in this repo** — `check:signature` gains a fake extension bridge, and
   the existing PAdES assertions run over a signature produced through the real protocol
   shape. The DSS validator remains the manual milestone check.

## Phases

Each phase ends somewhere demonstrable.

1. **Agent talks to a token.** ✅ Swift package, PKCS#11 enumeration and signing against
   SoftHSM, checks, CI on every push. A signature is verified through
   Security.framework against the certificate's own public key.
2. **The wire, end to end, locally.** ✅ *written* — protocol, native host, extension
   (pinned id), `dev-install.sh`. The host has been driven over real native-messaging
   framing; what remains is loading the extension in Chrome, which is a hands-on step.
3. **The real card.** ✅ Pointed at SecureStore, the agent enumerates the card:
   **29 certificates, none with a private key**, every one of them parseable. That is
   the truth about a card that has not been through certificate issuance.

   **Implementation note — the shim was not needed yet.** The plan had a stdio shim in
   front of a long-lived agent, to keep one owner of the card. The host is currently a
   single process per browser connection, which is what Chrome launches: acceptable
   while a session is opened and closed around each operation and the PIN authorises
   exactly one signature. If a card objects to two processes at once, the fix is to put
   the token behind an agent and make the host a pipe to it — the protocol does not
   change either way, which is why this was safe to defer.

   **Implementation note — the certificate is parsed in TypeScript.** The plan had the
   agent reporting certificate fields. It reports raw DER instead, and
   `lib/export/pdf/sign/certificateInfo.ts` reads subject, issuer, validity, key usage
   and the qualified claim out of it. The app already carries an ASN.1 stack for the
   CMS, so this removes an entire ASN.1 implementation from Swift and leaves one
   answer to "is this a QES" — in the language where `check:signature` can pin it.
4. **UI and packaging.** Pairing, PIN and confirmation windows; `.pkg`; `release.yml`
   with Developer ID signing, notarization, stapling, GitHub Release. *Done when* a
   fresh Mac installs from the release and signs.
5. **Deploy.** Extension published (store or policy), `track.zicha.dev` in
   `externally_connectable`, readiness UI shipped. *Done when* signing works from the
   deployed app.
6. *(Later)* Firefox, via the content-script transport.

Phases 1–3 need nothing from anyone. Phase 4 is where the prerequisites land.

## Prerequisites and open questions

- **Apple Developer Program** ($99/yr) is required for Developer ID signing and
  notarization in phase 4. Without it the helper still works, but installing it means
  right-click→Open past Gatekeeper, and that is not a "full solution". *Confirm
  availability before phase 4 — it does not block phases 1–3.*
- **`com.apple.security.cs.disable-library-validation`** must be on the agent's
  entitlements: it `dlopen`s SecureStore's module, and this is exactly the entitlement
  Fortify lacked when macOS killed it.
- **Chrome Web Store account** ($5) if taking the store route.
- CI secrets follow this project's convention — 1Password vault `Development`, item
  `zicha-sign-bridge-ci`: `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_TEAM_ID`,
  `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`, and the store credentials if used.
- The **extension keypair** is generated once and never rotated; losing it means a new
  extension ID and a reinstall everywhere. It belongs in 1Password beside the CI item.

## What changes in this repository

Small, and none of it before phase 2:

- `lib/export/pdf/sign/extensionBridge.ts` — a `TokenBridge` over the protocol above.
- `tokenBridge.ts` — add `readiness()`; `isAvailable()` derives from it.
- `bridge.ts` — offer it, ahead of the throwaway key.
- `ExportDialog.tsx` — render `BridgeReadiness` where the picker's notes sit.
- `fortify.ts` — deleted once the extension bridge signs, along with
  `@peculiar/fortify-client-core`.
