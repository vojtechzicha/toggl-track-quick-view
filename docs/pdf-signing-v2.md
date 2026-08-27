# PDF export v2 — qualified digital signing

Status: **phases 1–2 implemented** (2026-08-19); **phase 3's app side implemented**
(2026-08-22) and blocked on two things. The I.CA Premium USB has arrived, SecureStore
works and the card enumerates cleanly — but it **carries no certificate yet**, and
**Fortify crashes on macOS 26** (see the smoke test). Nothing has been signed with the
token. Vendor/product facts below were validated 2026-08-19 (some directly from
downloaded binaries); re-verify versions and prices if significant time has passed.

The design below is as approved. Where the implementation turned out to need something
the design did not anticipate, it is marked **Implementation note** — those are the
paragraphs to read if the code looks like it disagrees with the plan.

## Goal

Signed PDF exports (timesheet / acceptance sheet) where the visible signature block shows
the handwritten signature image next to the certificate details, backed by a real
cryptographic signature — not a pasted image.

Target format: **PAdES** (ETSI EN 319 142) at level **B-B**, later **B-T** (adds an
RFC 3161 timestamp). Signature level under eIDAS: **QES** — qualified certificate on a
qualified device (QSCD), legally equivalent to a handwritten signature EU-wide, shows as
trusted (green) in Adobe Reader via the EU Trust List with no user setup.

Key constraint that shaped the design: trust lists only admit certificates whose private
keys live on certified hardware, and browsers cannot talk to hardware tokens directly —
so signing stays client-side and needs a local bridge.

## The stack

| Layer | Choice |
|---|---|
| Certification agency | **I.CA** — TWINS certificate (qualified signature + commercial auth), 545 CZK/yr renewal, done online from SecureStore while the cert is valid. |
| Hardware (QSCD) | **I.CA Premium USB** (2 067 CZK incl. VAT, **ordered**): breakable Starcos 3.7 chip card + **A7 USB-C device** (requested in the order note; default shipped is A6 — any ACS CCID reader likely works, but only A7 is marketed for macOS). |
| Middleware | **I.CA SecureStore for macOS 8.3.1.0** (website still says 8.1; the installer ships 8.3.1.0, built 2026-06-12). Installs the PKCS#11 library at `/usr/local/lib/pkcs11/libICASecureStorePkcs11.dylib` — verified from the binary: **universal x86_64 + arm64**, supports Starcos 3.0/3.5/3.7. |
| Browser bridge | ~~Fortify v2.1.0~~ — **abandoned 2026-08-22**, it does not run on macOS 26 (see the smoke test). Replaced per "Fortify is out": I.CA's own PKIServiceHost on localhost now, a DIY helper or an I.CA licence for production. The `FortifyBridge` implementation and its `@peculiar/fortify-client-core` dependency were **deleted 2026-08-27**, the day the Sign Bridge extension signed with the card — the condition set for removing them. |
| Signature assembly | **@signpdf 3.3.0** (placeholder + CMS embedding, `ETSI.CAdES.detached`) + **@cantoo/pdf-lib 2.9.1** (maintained pdf-lib fork: incremental save built for signing, `drawSvg`, `embedPage`) + **PKI.js 3.4.0** (CMS SignedData, RFC 3161 client) + **@peculiar/asn1-ess** (`SigningCertificateV2`). All free/open source. |
| Visible appearance | **Stamp-PDF pattern** — the signature block is designed with pdfmake itself and embedded as the widget's appearance XObject (details below). |
| Timestamps | Ship **B-B** first. Add **B-T** later via a free TSA (freetsa.org, DigiCert, Czech `tsa.cesnet.cz`) through a stateless Next.js proxy route (public TSAs don't do CORS). Qualified PostSignum stamps (~2.5 CZK each, TSA100 pack) only if a *qualified* timestamp is ever legally needed — addable without redesign. |

Running costs: token + annual certificate only; all software is free. First year
≈ 2 067 CZK (bundle includes the first certificates).

### Fallbacks (in order, if Fortify's custom-card config fails)

Fortify's desktop app is dormant (last release 3/2025) and loading third-party PKCS#11
modules via `~/.fortify/config.json` (card ATR + dylib path) is its historically flaky
part — hence the smoke test below and the `TokenBridge` seam. **This ordering is
superseded.** The smoke test found worse than flaky — on macOS 26 Fortify is killed by
code signing before it can be configured at all — and investigating the fallbacks changed
their ranking. Read "Fortify is out — what replaces it" instead; the list below is kept
for the reasoning behind each candidate.

1. **DIY localhost helper** — small notarized native app (Node + `pkcs11js`, or Go/Swift)
   loading the SecureStore dylib and exposing `listCertificates()` / `signDigest()` over
   localhost to the same `TokenBridge` interface. ~days of code; packaging/notarization is
   the real cost. Chrome shows a one-time Local Network Access prompt; **Safari blocks
   loopback HTTP from HTTPS pages** → Chrome/Edge/Firefox only (acceptable; Fortify itself
   avoids this via a locally trusted TLS cert). Architecture proven on macOS this month by
   EasySigner (Czech OSS, eObčanka → PKCS#11 → PAdES B-B…B-LTA).
2. **ICAPKIService** — I.CA's own commercial browser component (host app + extension,
   macOS supported) that produces complete PAdES B-B/B-T itself; used by Czech government
   portals, licensable by third parties. Pricing via podpora@ica.cz.
3. **I.CA RemoteSign** — server-side QES via API + mobile-app confirmation; no local
   hardware. Pricing unpublished.

## Smoke test — run 2026-08-22: hardware good, Fortify broken

The token arrived and the hardware half of the stack checks out completely. **Fortify
2.1.0 does not survive on macOS 26.6.2**, which is the blocker.

### What works

| | |
|---|---|
| Reader | **ACS ACR40T ICC Reader** — the A7 USB-C device was shipped as requested, not the A6. |
| ATR | `3bda96ff81b1fe451f0780584943412056342e30ef`; historical bytes decode to ASCII `XICA V4.0`. Not in Fortify's `card.json` (v1.1.23, 85 cards, no I.CA entry), so a custom card entry is needed exactly as the design assumed. |
| Token | `ICA Starcos 3.74`, Giesecke & Devrient, serial `9203070300022806`, *PIN initialized*. |
| Middleware | SecureStore's PKCS#11 module works **standalone**: `pkcs11-tool --module /usr/local/lib/pkcs11/libICASecureStorePkcs11.dylib -T/-O/-M` enumerates the slot, its objects and its mechanisms. Nothing about the card or the middleware is in doubt. |

Two findings from that enumeration worth keeping:

- **The card holds only I.CA's *Test* CA certificates** (Test EU Qualified CA1/CA2/CA-SK,
  Test Qualified CA, Test Public CA) and no end-entity certificate — consistent with a
  card that has not been through certificate issuance yet. Note "Test": a production
  certificate will arrive with the production hierarchy, and a signature chaining to
  these would never be trusted by anything.
- **There is no `CKM_SHA256_RSA_PKCS`.** The token offers `RSA-PKCS` (raw sign),
  `RSA-PKCS-PSS`, and the SHA digests separately. So the DigestInfo has to be formed
  above the token and signed with raw `CKM_RSA_PKCS`. `webcrypto-local` does take that
  path for `RSASSA-PKCS1-v1_5`, so the bridge contract is unaffected — but it is the
  first thing to check if a signature comes out malformed rather than absent.

`opensc` (for `opensc-tool` / `pkcs11-tool`) comes from Homebrew and is worth having
installed: it is the only way to ask the card anything without going through Fortify,
which is what separated "the hardware is fine" from "the app is broken" here.

### What does not work: Fortify crashes

`FortifyApp` — the server half of the bundle — is killed by macOS a minute or so after
launch:

```
exception:   EXC_BAD_ACCESS / SIGKILL (Code Signature Invalid)
termination: CODESIGNING, "Invalid Page"
faulting frames: dyld … dlopen_from → JustInTimeLoader::makeJustInTimeLoaderDisk
```

It extracts its native addons (`pkcs11.node`, `pcsclite.node`) into a temp directory and
`dlopen`s them from there, and the binary itself is **ad-hoc signed with no Team ID and
no entitlements** (`codesign -dv` → `flags=0x2(adhoc)`, `TeamIdentifier=not set`). One
crash report per launch.

The symptom that reaches the app is that `https://127.0.0.1:31337` accepts connections
for a few seconds after launch and then refuses them — which reads like "Fortify is not
installed" to `FortifyBridge.isAvailable()`, correctly but unhelpfully. Before it dies it
gets far enough to log `Started` on `127.0.0.1:31337` (confirming the probe address in
`sign/fortify.ts` is right), start PCSC, initialise the reader, read the card's ATR, and
register **`MacOS Crypto`** as a provider — so the keychain-backed test path does exist
in principle.

Diagnosing this needs `"logging": true` in `~/.fortify/config.json` (off by default);
crash reports are in `~/Library/Logs/DiagnosticReports/FortifyApp-*.ips`.

### Where that leaves the choice

The design ranked the fallbacks assuming Fortify's *custom-card configuration* was the
flaky part. It never got that far: the app does not stay up long enough to configure. Its
newest release is 2025-03 and the project is dormant, so waiting for a fix is not a plan
— Fortify is out. What replaces it is the next section.

## Fortify is out — what replaces it (2026-08-22)

Fortify was going to be uninstalled after the crash above, so the bridge needs a
different implementation. Two candidates, both investigated rather than assumed.

### Option A — I.CA's own component (PKIServiceHost + ICAClientSign)

I.CA ships the thing Fortify was standing in for, free, from
[ica.cz/ke-stazeni](https://www.ica.cz/ke-stazeni). What was actually verified, by
unpacking `icapkiservicehost_mac_0.zip` and reading the published client library at
`ca.ica.cz/pub/ICAPKIService/`:

| | |
|---|---|
| Shape | Native messaging host (`/Library/I.CA/ICAPKIService/ICAPKIServiceHost`, **v3.1.3.0**) + a browser extension. The page calls `chrome.runtime.connect(extensionId)`; the extension relays to the host over stdio. No localhost socket at all — a different mechanism from Fortify's. |
| Signing | `ICAClientSign.js` exposes `signPades`, `signCadesDetached`, `signCmsDetached`, `signXml`, plus `certificateEnumerateStore` / `certificateLoadUserKeyStore*` for discovery and `pdfOptions*` for a visible block. PAdES B-B and B-T. |
| Code signing | **Properly signed** — `TeamIdentifier=NQV3834JPK`, hardened runtime. Not Fortify's ad-hoc build, so not Fortify's crash. |
| Architecture | **x86_64 only** (Feb 2024 build), so Rosetta on Apple silicon. Works today; a liability whenever Rosetta goes. |
| Cost | The download is free, and `ICAClientSign` is statically linked into the host — the *capability* costs nothing. |

**The blocker is the whitelist, and it is in two places.** The extension's manifest
(v2.2.1.0) restricts `externally_connectable.matches`, and the host's manifest restricts
`allowed_origins` to eleven fixed extension IDs. So neither "just use it from our domain"
nor "ship our own extension against their host" works. The extension's list reads as
I.CA's integrator roster:

```
"*://localhost/*", "*://*.localhost/*",
https://*.csob.cz/*, https://*.csob.sk/*, *://*.ica.cz/*, *://*.moneta.cz/*,
*://*.tatra.cz/*, *://*.sukl.cz/*, *://*.servis.justice.cz/*,
https://*.narodni-ca.gov.cz/*, *://*.circularo.com/*, *://*.digisign.org/*,
*://*.proebiz.com/*, *://*.eon.com/*, *://*.tsk-praha.cz/*, …
```

**`localhost` is on it, for any port and either scheme.** That single line is the whole
reason this option is worth having: `pnpm dev` on `http://localhost:3000` can drive the
card today, with the public extension and the free host, and no conversation with anyone.
`track.zicha.dev` cannot, and getting it added means licensing (podpora@ica.cz; the
`?extensionOwner=CSOB` parameter on their test pages shows it is a per-integrator,
per-branded-extension product).

**It also needs a seam we do not have.** `TokenBridge.signDigest()` asks for a signature
over bytes we chose — our SignedAttributes. I.CA's lowest useful primitive is
`signCadesDetached(content)`, which builds the CMS itself. So Option A is not a
`TokenBridge` implementation; it slots in one level higher:

```ts
interface DetachedCmsSigner { sign(content: Uint8Array): Promise<Uint8Array> }
```

with `CmsFromTokenBridge` (today's path: sha256 → buildCms → bridge) and `IcaClientSign`
(delegate the whole CMS) as its two implementations, and `PadesSigner` taking one. That
keeps `prepare.ts`, `appearance.ts`, `widget.ts` and the whole stamp-PDF design intact —
the visible block stays ours, which `signPades` would not allow. The open question is
whether I.CA's detached CAdES-B-B carries PAdES-conformant signed attributes (no signed
signing-time); the CAdES baseline forbids it too, so it probably does, but the DSS
validator has to say so before this is called done.

### Option B — the DIY localhost helper (fallback 1, now specified)

Everything the helper needs to talk to is already proven working from `pkcs11-tool`, so
the unknowns are packaging, not cryptography.

- **Language: Go**, with `github.com/miekg/pkcs11`. A single static binary, no runtime to
  bundle — which is exactly what killed Fortify, whose Node addons were extracted to a
  temp directory and `dlopen`ed from there.
- **Transport: plain HTTP on `127.0.0.1`**, fixed port. Chrome, Edge and Firefox exempt
  loopback from mixed-content blocking, so an `https://track.zicha.dev` page can call it;
  Chrome asks once via its Local Network Access prompt. Safari cannot, so signing is
  Chrome/Edge/Firefox only — acceptable, and already the case for every option here.
- **API is `TokenBridge` verbatim**, which is the point of having the seam:
  `GET /v1/status` → `isAvailable()`; `GET /v1/certificates` → `listCertificates()`;
  `POST /v1/sign {certificateId, data, hash}` → `signDigest()`; `GET /v1/chain/:id` →
  `certificateChain()`.
- **PKCS#11 specifics, already known**: module
  `/usr/local/lib/pkcs11/libICASecureStorePkcs11.dylib`; token `ICA Starcos 3.74`;
  PIN 6–8 digits; and **no `CKM_SHA256_RSA_PKCS`**, so the helper builds the DigestInfo
  itself and signs with raw `CKM_RSA_PKCS`.
- **Security is the design, not a footnote.** A daemon that signs arbitrary bytes with a
  QES key is a liability if any page can reach it. Three layers: an `Origin` allowlist
  (browser-set, so page script cannot forge it); a first-use pairing approval per origin,
  shown as a matching code in the helper and on the page, exactly as Fortify does; and
  **`C_Login` per signature**, so every signature costs a PIN typed into the helper's own
  window, never into the browser. The PIN prompt is the consent.
- **Packaging is the real cost**, and Fortify's corpse says what to get right: Developer
  ID signature, notarization, stapling, hardened runtime — plus
  `com.apple.security.cs.disable-library-validation`, which is required to `dlopen`
  SecureStore's module and is precisely the entitlement Fortify did not have. Needs an
  Apple Developer account.
- **Rough effort**: 1–2 days for PKCS#11 + HTTP, 1–2 for pairing and the confirmation UI,
  1 for signing and distribution. Call it a week, and none of it touches the app.

### Decision (2026-08-22): neither — build our own

Option A was taken as far as it goes and then rejected: `localhost` is whitelisted but
`track.zicha.dev` is not, and a custom extension cannot borrow I.CA's helper either,
because that helper's `allowed_origins` pins eleven extension IDs. Owning the extension
means owning the native side, which is Option B with a better transport than a localhost
port. **The plan is `sign-bridge-plan.md`**; the reasoning below is what led there and is
kept for that.

~~**Take Option A on localhost now, and decide about production later.**~~ It costs nothing,
needs no build, and the certificate is not here yet anyway — so the next milestone
(a real qualified signature that validates green) is reachable the day the certificate
arrives, without committing to a week of native development first. Only *deployment* is
blocked, and the answer to that is a question with three answers — licence the domain
from I.CA, build the helper, or accept that signing happens on the machine that has the
card — none of which has to be answered before we know signing works at all.

## Architecture

Current pipeline (`lib/export/pdf/index.ts`): `toPDF(doc, templateId)` lazy-loads pdfmake
and returns a `Blob`, invoked from `components/export/ExportDialog.tsx`. All client-side —
signing stays client-side too, since the private key is on the user's token.

New module `lib/export/pdf/sign/`, an optional post-processing stage:

```
toPDF() Blob
  → renderAppearance(rect, appearance)        [pdfmake]
      the visible block as a one-page PDF exactly the size of the widget rect
  → prepareSignature(blob, appearance)        [@cantoo/pdf-lib + @signpdf placeholder]
      adds the signature field + visible widget (stamp-PDF appearance) and a
      /Contents placeholder; save({ useObjectStreams: false }); returns bytes + ByteRange
  → buildCMS(byteRangeDigest, cert, chain)    [PKI.js + @peculiar/asn1-ess]
      SignedData, subFilter ETSI.CAdES.detached; signed attributes EXACTLY:
      content-type, message-digest, signing-certificate-v2 — PAdES-B forbids a signed
      signing-time attribute; the time goes in the signature dictionary's /M entry
      → bridge.signDigest(signedAttributes)   [TokenBridge: Fortify impl / helper impl]
          user approves, enters token PIN; RSASSA-PKCS1-v1_5 over SHA-256
  → embedCMS(bytes, cms)                      → PAdES-B-B PDF Blob
  → (later) RFC 3161 timestamp as unsigned attribute via TSA proxy route → PAdES-B-T
```

**Implementation note — what the bridge signs.** The sketch above originally had
`bridge.signDigest(byteRangeDigest)` feeding `buildCMS`, which is the wrong way round:
in CMS the bytes that get signed are the DER-encoded SignedAttributes, and the byte
range's digest is only one attribute *inside* them. So `buildCMS` runs first and calls
the bridge in the middle. The interface keeps the name `signDigest`, but its argument is
the SignedAttributes and the bridge hashes them itself — matching WebCrypto's
`subtle.sign`, Fortify's remote crypto, and PKCS#11's `CKM_SHA256_RSA_PKCS`, none of
which take a bare digest.

**Implementation note — the client library, and why not the webcomponents.** The design
named `@peculiar/fortify-webcomponents`. What the bridge actually needs is that package's
dependency, **`@peculiar/fortify-client-core`** — the headless client. The webcomponents
package is the same API wrapped in Stencil custom elements that render a certificate
picker of their own; here the picker is the export dialog, which already has the app's
form styling and has to show things Fortify's component knows nothing about (which
template, which handwritten scan). Taking the core alone skips Stencil entirely.

Its shape maps onto `TokenBridge` almost exactly: `start()` / `challenge()` / `login()`
for pairing, `getProviders()` + `getCertificatesByProviderId()` for discovery, and
`getProviderById()` → `certStorage.findPrivateKey()` → `subtle.sign()` for signing. Three
things needed deciding on top of it:

- **`isAvailable()` must not download the client.** It runs on every bridge the moment
  signing is switched on, and constructing a `FortifyAPI` pulls in protobuf.js and the
  socket implementation — a megabyte or so to discover Fortify is not installed. So the
  bridge probes `https://127.0.0.1:31337/.well-known/webcrypto-socket` with a plain
  fetch and imports nothing until there is something to talk to. That duplicates the
  library's own `FORTIFY_URL`, and `check:signature` asserts the two still agree —
  drift there would not look like a bug, it would look like Fortify simply never being
  offered.
- **Listing is a deliberate act.** `getCertificatesByProviderId()` logs in to each
  provider (it has to, to enumerate private keys), which means a card PIN prompt. A PIN
  prompt nobody asked for is indistinguishable from a bug, so `TokenBridge` gained
  `interactive`, and the dialog offers a *Connect and list certificates* button for a
  bridge that has it rather than listing on switch-on. The throwaway bridge, which asks
  nobody anything, still lists immediately.
- **The chain is fetched for one certificate, not all of them.** `TokenCertificate.chain`
  comes back empty from the hardware bridge and `signPdf()` calls the optional
  `certificateChain()` for the one being signed with. On the Sign Bridge bridge that
  costs no round trip at all: the card carries its issuer's CA certificates alongside
  its own — that is what the other thirty objects on it are — so the chain is a walk up
  the list already fetched, matching each certificate's encoded issuer name against
  another's encoded subject. It stops at a self-issued certificate and ships whatever it
  reached; the leaf is never repeated, because `buildCms` ships `[signerCert, ...chain]`.

**Implementation note — the certificate is chosen, never assumed.** Phase 2's dialog took
the first certificate the first available bridge offered, which is correct when a bridge
holds exactly one. A TWINS card holds **two**, issued to the same person: the qualified
signature certificate and the commercial authentication one. Signing an acceptance sheet
with the second produces a file that verifies cryptographically, shows a signature panel,
and is not a QES — a failure with no visible symptom. So `TokenCertificate` carries
`qualified` (from the client's `X509Schema.isQualified()`, i.e. the certificate's own
qcStatements and policies) and `forSignature` (key usage includes nonRepudiation), the
picker preselects the certificate that is both, and the dialog says out loud when the
chosen one is neither. A third flag, `hasKey`, is what the picker FILTERS on rather than
warns about, and the real card is why: it reports 31 certificates and holds the private
key of 2. The other 29 are its issuer's CA certificates, and offering one is offering a
PIN prompt that ends in "no private key". Both flags are *claims read off the certificate*: false is
reliable, true is an expectation, and the verdict still belongs to a validator checking
the Trust List. That is the right way round for warning someone before they sign.

**Implementation note — one copy of pdf-lib.** `@signpdf/placeholder-pdf-lib` does
`require('pdf-lib')` while this code imports `@cantoo/pdf-lib`. Two things follow.
`pdf-lib` is declared in package.json as an alias for the fork, and both specifiers are
pinned to the fork's ES build (`next.config.js` for the bundle,
`scripts/signatureFixture.ts` for the checks) because the package's exports map answers
`require` and `import` with *different builds*. Two builds means two PDFName pools, and
pdf-lib keys dictionaries by PDFName identity — so the placeholder would write an
`/AcroForm` that the code looking for the widget cannot see. It fails silently and only
at the point where the appearance is attached.

Design rules:

- **Signing is optional and additive.** No bridge detected, or the user skips signing →
  the unsigned export works exactly as today. No regression risk to v1 templates.
- The digest is computed over the prepared PDF's ByteRange after pdfmake and the
  placeholder step are completely finished; nothing about existing generation changes.
- pdfmake (pdfkit ^0.19) emits classic xref tables — pdf-lib parses its output cleanly.
  Re-save with `useObjectStreams: false` (object streams break @signpdf's ByteRange
  handling). Avoid `@signpdf/placeholder-plain` (fragile). A second signature on an
  already-signed file requires @cantoo/pdf-lib's incremental save.
- `@signpdf` needs the standard `buffer` polyfill in the browser bundle.
- `@signpdf/signer-p12` is **not** PAdES-conformant (adds a signed signingTime) — it is a
  dev-only tool for phase 2's throwaway-cert testing; the real signer is custom (~150
  lines on PKI.js).

**Implementation note — two ASN.1 library bugs to know about.** Both were found by
validators rather than by reading, and both are worked around in `sign/`:

- `@peculiar/asn1-ess`'s `IssuerSerial` declares `serialNumber` as a bare
  `AsnPropTypes.Integer`, whose converter encodes through `+value`. Certificate serials
  arrive from `@peculiar/asn1-x509` as raw INTEGER content octets (up to 20 bytes), and
  `+arrayBuffer` is `NaN` — so signing-certificate-v2 carried serial 0 and pyHanko
  rejected the signature outright. `cms.ts` overrides `toASN()` on a subclass, which is
  the library's own escape hatch; the rest of the structure still comes from the
  published ASN.1 module.
- PKI.js's `RelativeDistinguishedNames` packs everything in `typesAndValues` into one
  multi-valued RDN and does not DER-sort that SET. Certificates *built* with it are then
  re-encoded differently by anything that canonicalises before hashing, which broke
  signing-certificate-v2 against DSS. `throwaway.ts` emits a proper RDNSequence of
  single-attribute RDNs. Certificates *parsed* from DER — every certificate in the real
  flow, the token's included — round-trip through PKI.js byte-identically, verified
  against a multi-RDN certificate from OpenSSL, so the real signing path was never
  exposed to this.

## Visible signature appearance — stamp-PDF pattern

The appearance is a form XObject on the signature widget: an arbitrary PDF content
stream. Validators (Adobe, DSS, pyHanko) verify bytes and CMS only and never constrain
the appearance — so the design is fully free: images with alpha, embedded fonts, vectors.

The signature block is authored **with pdfmake itself**: rendered as a tiny standalone
PDF (same fonts, layout language, and theming as the export templates) and embedded as
the appearance via `embedPage`. This makes the design customizable with zero new tooling
— handwritten PNG + name + date + certificate CN composed freely.

**Implementation note — the preview.** Showing that same stamp PDF in the ExportDialog
does not work: at 280×95pt the browsers' built-in PDF viewers ignore `#view=Fit` and
render the page at a zoom of their own, so the preview showed a corner of the block
blown up (Chromium, tested across `view`/`zoom` combinations). The dialog therefore
draws the block in HTML at 1pt = 1px, from the same appearance values and the same
measurements the pdfmake definition uses (`STAMP_STYLE` in
`lib/export/pdf/sign/types.ts`), so the two cannot drift on size or spacing. It is a
preview of the design at printed size rather than of the PDF bytes.

Rules that keep Adobe happy:

- One **flat** XObject (no legacy n0/n2 layering; n1/n3/n4 are forbidden since Acrobat 6).
- The XObject must carry a `/Resources` dict even if empty (Acrobat quirk; @signpdf
  already defends it).
- The appearance is written **before** signing so it sits inside the signed ByteRange —
  true by construction here.
- Subset-embed every font; keep the XObject BBox equal to the widget Rect; render the
  visible date from the same clock as `/M`.

**Implementation note — the BBox.** "Equal to the widget Rect" means equal in *size*:
the XObject's BBox is `[0, 0, w, h]` with an identity Matrix, which is what `embedPdf`
produces from a stamp page of exactly that size and what Acrobat itself writes. A
viewer maps the transformed BBox onto the Rect, so same size at the origin maps 1:1.
`scripts/check-signature.ts` asserts the two are the same size rather than the same
numbers.

**Which box gets signed.** The app signs as the document's **issuer**, so the widget
belongs in the issuer's box and nowhere else. That is the *Prepared by* box on the
report templates' sign-off page (`lib/export/pdf/report.ts`, both languages). The
*Approved by* box beside it, and the acceptance protocol's dashed box, belong to the
**client countersigning** — they carry no widget, stay ordinary flowing content, and
keep a date prompt for whoever signs them by hand or in their own reader.

*(This was got wrong first time round: the acceptance protocol's box looks like the
obvious place for a signature and is in fact the approver's. Worth stating plainly here
so it is not re-derived incorrectly later.)*

**Widget placement contract.** A signature block drawn as flowing pdfmake content has a
page and a Y that vary — with the number of table rows, with whether the investment box
is printed, with how far the declaration wraps — and the finished blob handed to
`prepareSignature()` carries no metadata about where it landed. So the visual box alone
is not a usable position config. Each signable template instead declares an explicit
`signatureWidget: { rect }` — a fixed rectangle anchored above the bottom margin, valid
on the **last page** — and *guarantees* it rather than reporting it.
`prepareSignature()` then places the widget at `rect` on the last page deterministically
— converting from pdfmake's top-left origin to the PDF bottom-left origin — with no
post-hoc geometry scanning.

**Implementation note — how the guarantee is made.** `pageBreakBefore` alone cannot
carry it: pdfmake drops zero-extent nodes from the list its rule walks, and an
absolutely positioned node reports its *absolute* Y as `startPosition.top` rather than
the flow's. So the template emits two things: an invisible canvas node exactly as tall
as the signature row (a fully transparent fill, since `lineWidth: 0` means a hairline,
not no line), which makes pdfmake's own "does this still fit above the bottom margin"
arithmetic push the row onto a fresh page; and the `pageBreakBefore` rule keyed on that
node's id, which asserts the same thing directly. The row itself is drawn as absolutely
positioned pieces, so the dashed box's Y needs no text metrics.

Two consequences for the report's sign-off page. The *Basis of preparation* box moved
**above** the signatures, because the row is bottom-anchored and anything after it in
the flow would have nowhere to go. And the row keeps a 12pt clearance from the bottom
margin: pdfmake applies its does-this-line-fit test to absolutely positioned content
too, so content flush against the margin gets moved to a page of its own — which would
also make that empty page the last one, and the widget follows the last page.

Swept over both languages × 9 document lengths × with and without fees and a long
engagement note: both sign blocks land on the last page every time, and on no other.

The handwritten signature image is a
user-supplied PNG and **must not be committed to the repo** — loaded at export time (file
picker) or from the app's Mongo-backed config, embedded only into the appearance stream.

**Implementation note — where the image is remembered.** It is an export identity field
like the rest (`lib/exportFields.ts`): held as a `data:` URL, scoped to the workspace,
and carried across devices by settings sync, which is the Mongo-backed config. The
dialog caps what it will store (`MAX_SIGNATURE_IMAGE_CHARS`, ~256 kB of base64) —
a larger scan is used for the export at hand and not written into a document that syncs
on every settings change. `.gitignore` covers `signature.png`, `signature-*.png`,
`*.signature.png` and `/signatures/` so the file can live in the working tree.

## Validation

- **EU DSS demo validator** (EC digital-building-blocks webapp) — the conformance oracle:
  reports the exact profile (`PAdES-BASELINE-B/T`) and QES determination against the EU
  Trust List. Use at every milestone. It has a REST endpoint
  (`…/webapp-demo/services/rest/validation/validateSignature`, POST
  `{"signedDocument":{"bytes":"<base64>","name":"x.pdf"}}`), which is how phase 2 was
  checked without the webapp.
- **Adobe Acrobat Reader** — EUTL enabled by default; I.CA is on the Czech trusted list,
  so a correct signature shows the green banner untouched. The socially decisive test.
- **CI** — `check:signature` script running pyHanko CLI (crypto + trust; it explicitly
  does not check profile conformance) over a committed fixture signed with a throwaway
  cert. Profile conformance via the self-hostable `dss-demonstrations` REST validator,
  run manually at milestones.

**Implementation note — the two validators disagree, usefully.** pyHanko validates
against the bytes it received; DSS re-encodes through BouncyCastle first. A certificate
whose DER is merely *legal* rather than canonical therefore passes pyHanko and fails
DSS, with a cascade of misleading symptoms ("the signature is not intact", "the key size
is unknown") behind one real cause. Run both; DSS is the one that catches encoding sins.

**Implementation note — pyHanko's CLI moved.** It ships as the separate `pyhanko-cli`
package now (`pipx install pyhanko-cli`); installing `pyhanko` alone gives the library
and no binary. `check:signature` skips the pyHanko half with a message when the binary
is absent, so a missing Python tool never disables the whole check chain; `PYHANKO` can
point at it.

### DSS validator, 2026-08-22 — the profile is right

Run against `scripts/fixtures/signed-report.pdf` on DSS Demonstration WebApp 6.4,
policy "QES AES/QC AES TL based". The fixture rather than a real export, deliberately:
the validator's own privacy notice advises against sending anything sensitive, a real
timesheet is a client's data, and the profile is decided by structure rather than
content — the fixture comes off the same `toPDF` → `prepareSignature` → `buildCms` path
that every export does.

```
Signature format:   PAdES-BASELINE-B          ← the question this run answered
Signature scope:    Full PDF (FULL)
ByteRange:          [0, 57957, 66151, 2018]
On claimed time:    2026-08-19 10:30:00 (UTC) ← our /M, read as the claimed time
Indication:         INDETERMINATE
Sub indication:     NO_CERTIFICATE_CHAIN_FOUND
```

**What matters is what is absent.** Not one complaint about structure: no objection to
the signed attributes, no note about the appearance stream, no partial-coverage warning
— "Full PDF (FULL)" says the signature covers the document rather than a revision of it.
The single failure is `NO_CERTIFICATE_CHAIN_FOUND`, which is not a defect: the throwaway
certificate is self-signed and chains to no trust anchor, so "0 valid signatures out of
1" is the correct verdict about a key invented in a browser.

That is the whole pipeline cleared ahead of the certificate. What the qualified
certificate changes is the trust decision and nothing else — `Qualification: N/A`
becomes a QES determination, and the indication becomes TOTAL_PASSED. Nothing in the
document has to change for that to happen.

Worth repeating once a certificate exists, and worth repeating on a hardware-signed
file — signing the FIXTURE document through the token would give both a real chain and
no client data, which is the run to make.

**Still to do (2026-08-27).** The card-signed run has been verified locally — chain,
digest, signature, attributes — but has **not** been through the DSS validator, because
the file signed was a real client timesheet and the fixture has not been signed with the
card yet. That is the outstanding milestone check: sign `scripts/fixtures`' report
through the token and put it through DSS, which should turn `Qualification: N/A` into a
QES determination and `NO_CERTIFICATE_CHAIN_FOUND` into TOTAL_PASSED.

### Phase 2 results (2026-08-19)

Fixture: `scripts/fixtures/signed-report.pdf`, signed with the committed throwaway
key.

- **EU DSS demo validator** — `SignatureFormat: PAdES-BASELINE-B`, signature scope
  `FULL` ("The document ByteRange"), one error: *the certificate chain for signature is
  not trusted, it does not contain a trust anchor*. That is the whole of what should be
  wrong with a self-signed throwaway certificate.
- **pyHanko** — VALID against the fixture's own certificate as trust anchor;
  cryptographically sound, `sha256`, `rsassa_pkcs1v15`, covers the entire file.
- **Adobe Acrobat Reader** — not run here (no Acrobat in the build environment). The
  structural properties Acrobat is fussy about are asserted instead: flat single
  appearance XObject, `/Resources` present, BBox sized to the Rect, `/SubFilter
  /ETSI.CAdES.detached`, `/M` present. Worth eyeballing once on a real machine.

## Implementation phases

1. **Placeholder + appearance** — ✅ **done.** `prepareSignature()` with the stamp-PDF
   visible widget; the widget placement contract (`signatureWidget: { rect }`) and the
   reworked acceptance signature block.
2. **CMS assembly + embed** — ✅ **done.** Custom PAdES signer on PKI.js, exercised with a
   self-signed throwaway key via WebCrypto; `PAdES-BASELINE-B` per the DSS validator (see
   the results above). `TokenBridge` is defined and has its WebCrypto implementation;
   signing is offered from the ExportDialog behind a switch that is off by default.
3. **Bridge wiring** — ✅ **done 2026-08-27. A real qualified signature has been made.**
   Both blockers cleared: Fortify was replaced by our own extension and helper (see
   `sign-bridge-plan.md`), and the card went through certificate issuance. The card now
   reports 31 certificates, 2 of them with a private key — an RSA-4096 qualified
   signature certificate from *I.CA EU Qualified CA2/RSA 06/2022*, and the commercial
   authentication half of the TWINS pair beside it, which is the case the picker was
   written for and is no longer hypothetical.

   The run: export dialog → `ExtensionBridge` → extension → native host → PKCS#11 →
   ACR40T → card, with the PIN typed in the helper's own window. Result verified
   independently of the code that made it: 2 certificates in the CMS (leaf + issuing CA,
   built by the chain walk), `messageDigest` equal to SHA-256 over the ByteRange, a
   512-byte signature verifying against the certificate's own public key,
   `signingCertificateV2` present and no signing-time attribute. `FortifyBridge` and
   `@peculiar/fortify-client-core` were deleted the same day.
4. **B-T timestamp** — ✅ **done 2026-08-27.** `lib/export/pdf/sign/timestamp.ts` builds
   the RFC 3161 request and — this is the part that matters — checks the answer;
   `app/api/timestamp/route.ts` is the proxy; `cms.ts` embeds the token as
   `id-aa-signatureTimeStampToken`. Off unless `TSA_URL` is set, and reported through
   `/api/config` so the dialog never promises a timestamp the deployment cannot make.
   See "Timestamps" below.

### What only the real card revealed (2026-08-27)

Three defects that no amount of SoftHSM or throwaway-key testing would have found, all
fixed:

- **The placeholder was too small.** `@signpdf`'s `DEFAULT_SIGNATURE_LENGTH` is 8192,
  and — the trap — it counts **hex characters, not bytes**, so it reserves 4 KiB of CMS.
  A 2048-bit throwaway key with no chain fits in a third of that. An RSA-4096 signer
  certificate (2459 B), its RSA-4096 issuing CA (1806 B) and a 512-byte signature come to
  5317 B, and the export died on `Signature exceeds placeholder length: 10634 > 8192` —
  *after* the PIN had been typed and the card had already signed. `signPdf()` now
  measures instead of guessing: it builds the CMS once over a zero digest and a zero
  signature, which has exactly the length the real one will have (a CMS's DER length is
  fixed by the sizes of the certificate, the chain and the signature, never by their
  values), and reserves that plus a margin, doubled for the hex encoding.
- **Every certificate on the card was offered.** The picker listed all 31, including 29
  CA certificates with no private key here, several already expired. It filters on
  `hasKey` now — which meant separating "the issuer intended this for signing"
  (`forSignature`, read from the DER) from "this machine can act on it" (`hasKey`), two
  things the code had been conflating.
- **Any failure blamed Toggl.** The export dialog's catch-all reported *"Could not load
  this range from Toggl"* for everything it did not recognise — which covers the entire
  render-and-sign half of the pipeline. The placeholder overflow above presented as a
  network error, and finding the real message needed a code change. It now reports what
  actually happened.

A fourth was in the helper, not here: SecureStore's dylib destructor joins a heartbeat
thread that only `C_Finalize` stops, so the host hung **forever inside `exit()`** while
holding the card. See `sign-bridge-plan.md`.

## Timestamps — PAdES-B-T (2026-08-27)

Acrobat's third line on a B-B signature is *"signing time is from the clock on the
signer's computer"*, and it is not a nitpick. The certificate is issued for a year. With
no timestamp there is nothing to distinguish a signature made while it was valid from one
made after it expired, so on 2027-08-27 every timesheet ever sent quietly stops
verifying. The timestamp is the evidence that the signature existed at a time, and it
keeps working forever.

**Shape.** The token covers the SIGNATURE VALUE, not the document, so it cannot exist
until after the card has signed — which is why it goes in as an *unsigned* attribute, the
one place it can go without disturbing bytes the card has already committed to.

**Checking the answer is most of the work.** A token over the wrong digest, or replayed
from an older exchange, parses exactly as cleanly as a correct one; the first thing to
notice would be a validator, long after the file reached a client. So the client sends a
random nonce and refuses a response that is not granted, carries no token, timestamps a
different digest, echoes a different nonce, echoes none at all, or whose eContent is not
a TSTInfo. Each of those is a check in `check:signature`, against a locally built TSA.

**Two decisions worth knowing about:**

- **A failed timestamp does not fail the export.** By the time the TSA is called the
  person has entered a PIN and the card has signed; a TSA that is down must not throw
  that away. The file ships at B-B and the dialog *says so*, naming the failure — the
  unacceptable outcome is not the lower level, it is someone believing they have a
  timestamp they do not have.
- **The reservation is an allowance, not a measurement.** Everything else in the CMS is
  measured exactly (see the placeholder note above), but a token cannot be measured
  without buying one, so it gets a flat 12 KiB against tokens that run 1.5–6 KiB. A real
  DigiCert token measured 6005 bytes with a three-certificate chain. Over-reserving costs
  padding; under-reserving costs a signature that has already been made.

**Configuration.** `TSA_URL`, plus `TSA_CREDENTIALS` for a commercial authority — see
`.env.example`. The destination is read only by the proxy: a route that forwarded to a
URL from the request body would be an SSRF hole with a timestamp-shaped excuse. Nothing
about the document leaves; the request is a hash of the signature and nothing else.

**Qualified vs not.** A QES with a *non-qualified* timestamp is still a QES, and a
free TSA in the common trust stores (DigiCert, freetsa.org) is enough for the practical
goal — surviving the certificate's expiry. A *qualified* timestamp (eIDAS art. 42) is a
paid product from I.CA or PostSignum at a few CZK a stamp, and is only needed when the
timestamp itself must be qualified. Switching is one environment variable.

## Legal notes

- The handwritten image is cosmetic; the CMS signature is the legal act. Never ship a
  template that embeds the image without the cryptographic layer — it looks signed but is
  a plain SES and trivially copyable.
- QES is equivalent to a handwritten signature (eIDAS art. 25); for B2B acceptance sheets
  this exceeds requirements — which is fine.
- Certificate renewal is annual; signatures made with an expired cert won't validate
  without a timestamp. That was the argument for B-T, which is now implemented — see
  "Timestamps" above. It is off until `TSA_URL` is set, so an export from a deployment
  without one is still B-B and still expires with the certificate.

## References

- I.CA Premium USB: https://www.ica.cz/ica-premium-usb
- I.CA SecureStore (macOS, PKCS#11): https://www.ica.cz/en/secure-store
- Fortify releases: https://github.com/PeculiarVentures/fortify-releases
- Fortify custom card config: https://github.com/PeculiarVentures/fortify/issues/439
- @signpdf: https://github.com/vbuch/node-signpdf · @cantoo/pdf-lib: https://github.com/cantoo-scribe/pdf-lib
- PKI.js: https://github.com/PeculiarVentures/PKI.js · @peculiar/asn1-ess (SigningCertificateV2)
- PAdES: ETSI EN 319 142-1 (signed attrs; no signed signing-time in baseline profiles)
- EU DSS demo validator: https://ec.europa.eu/digital-building-blocks/DSS/webapp-demo/validation
- pyHanko CLI: https://github.com/MatthiasValvekens/pyHanko
- ICAPKIService (fallback): https://www.ica.cz/ica-pkiservice · I.CA RemoteSign (fallback): https://www.ica.cz/en/ica-remotesign
