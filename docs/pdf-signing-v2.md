# PDF export v2 — qualified digital signing

Status: **approved and hardware ordered** (2026-08-19, I.CA Premium USB with the A7
device). Implementation phases 1–2 can start now; phase 3 waits for the token.
Vendor/product facts below were validated 2026-08-19 (some directly from downloaded
binaries); re-verify versions and prices if significant time has passed.

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
| Browser bridge | **Fortify v2.1.0** (native arm64 `.pkg` from [`PeculiarVentures/fortify-releases`](https://github.com/PeculiarVentures/fortify-releases); the original repo is archived). Web side: `@peculiar/fortify-webcomponents` (still actively published). Accessed through a **`TokenBridge` interface** so a DIY localhost helper can replace it without app changes (see Fallbacks). |
| Signature assembly | **@signpdf 3.3.0** (placeholder + CMS embedding, `ETSI.CAdES.detached`) + **@cantoo/pdf-lib 2.9.1** (maintained pdf-lib fork: incremental save built for signing, `drawSvg`, `embedPage`) + **PKI.js 3.4.0** (CMS SignedData, RFC 3161 client) + **@peculiar/asn1-ess** (`SigningCertificateV2`). All free/open source. |
| Visible appearance | **Stamp-PDF pattern** — the signature block is designed with pdfmake itself and embedded as the widget's appearance XObject (details below). |
| Timestamps | Ship **B-B** first. Add **B-T** later via a free TSA (freetsa.org, DigiCert, Czech `tsa.cesnet.cz`) through a stateless Next.js proxy route (public TSAs don't do CORS). Qualified PostSignum stamps (~2.5 CZK each, TSA100 pack) only if a *qualified* timestamp is ever legally needed — addable without redesign. |

Running costs: token + annual certificate only; all software is free. First year
≈ 2 067 CZK (bundle includes the first certificates).

### Fallbacks (in order, if Fortify's custom-card config fails)

Fortify's desktop app is dormant (last release 3/2025) and loading third-party PKCS#11
modules via `~/.fortify/config.json` (card ATR + dylib path) is its historically flaky
part — hence the smoke test below and the `TokenBridge` seam.

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

## Smoke test — run when the token arrives, before writing bridge code

1. Install SecureStore and `Fortify_*_arm64.pkg`; plug in the token; confirm SecureStore
   sees the card and certificates.
2. Read the card's ATR (`opensc-tool --atr`, or Fortify's log on unknown-card insert).
3. Add the card to `~/.fortify/config.json`
   (`cards: [{ name, atr, libraries: ["/usr/local/lib/pkcs11/libICASecureStorePkcs11.dylib"] }]`),
   restart Fortify.
4. On Fortify's demo tools page (tools.fortifyapp.com), approve pairing and check the
   qualified certificate is listed and signs test data after PIN entry.
5. Verify raw RSA signing over an arbitrary digest works (some token profiles restrict
   mechanisms; Firefox/Adobe use the same PKCS#11 path, so this should pass).

Steps 4–5 failing with "token seen, certs not listed" is Fortify's known failure mode —
switch to fallback 1 rather than debugging it.

## Architecture

Current pipeline (`lib/export/pdf/index.ts`): `toPDF(doc, templateId)` lazy-loads pdfmake
and returns a `Blob`, invoked from `components/export/ExportDialog.tsx`. All client-side —
signing stays client-side too, since the private key is on the user's token.

New module `lib/export/pdf/sign/`, an optional post-processing stage:

```
toPDF() Blob
  → prepareSignature(blob, appearance)        [@cantoo/pdf-lib + @signpdf placeholder]
      adds the signature field + visible widget (stamp-PDF appearance) and a
      /Contents placeholder; save({ useObjectStreams: false }); returns bytes + ByteRange
  → bridge.signDigest(byteRangeDigest)        [TokenBridge: Fortify impl / helper impl]
      user approves, enters token PIN; raw RSA-SHA256 signature
  → buildCMS(signature, cert, chain)          [PKI.js + @peculiar/asn1-ess]
      SignedData, subFilter ETSI.CAdES.detached; signed attributes EXACTLY:
      content-type, message-digest, signing-certificate-v2 — PAdES-B forbids a signed
      signing-time attribute; the time goes in the signature dictionary's /M entry
  → embedCMS(bytes, cms)                      → PAdES-B-B PDF Blob
  → (later) RFC 3161 timestamp as unsigned attribute via TSA proxy route → PAdES-B-T
```

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

## Visible signature appearance — stamp-PDF pattern

The appearance is a form XObject on the signature widget: an arbitrary PDF content
stream. Validators (Adobe, DSS, pyHanko) verify bytes and CMS only and never constrain
the appearance — so the design is fully free: images with alpha, embedded fonts, vectors.

The signature block is authored **with pdfmake itself**: rendered as a tiny standalone
PDF (same fonts, layout language, and theming as the export templates) and embedded as
the appearance via `embedPage`. This makes the design previewable in the ExportDialog
before signing and customizable with zero new tooling — handwritten PNG + name + date +
certificate CN composed freely.

Rules that keep Adobe happy:

- One **flat** XObject (no legacy n0/n2 layering; n1/n3/n4 are forbidden since Acrobat 6).
- The XObject must carry a `/Resources` dict even if empty (Acrobat quirk; @signpdf
  already defends it).
- The appearance is written **before** signing so it sits inside the signed ByteRange —
  true by construction here.
- Subset-embed every font; keep the XObject BBox equal to the widget Rect; render the
  visible date from the same clock as `/M`.

**Widget placement contract.** The existing dashed `signatureBlock`
(`lib/export/pdf/templates.ts`) is flowing pdfmake content: its page and Y position vary
with the number of table rows, and the finished blob handed to `prepareSignature()`
carries no metadata about where it landed. So the visual box alone is not a usable
position config. Each signable template instead declares an explicit
`signatureWidget: { rect }` — a fixed rectangle anchored above the bottom margin, valid
on the **last page** — and guarantees it in phase 1 by rendering the dashed box at that
fixed `absolutePosition`, with a `pageBreakBefore` rule (pdfmake exposes node
`startPosition`) that pushes the block onto a fresh page whenever the flow has already
passed the reserved Y. `prepareSignature()` then places the widget at `rect` on the last
page deterministically — converting from pdfmake's top-left origin to the PDF
bottom-left origin — with no post-hoc geometry scanning. Reworking `signatureBlock` to
this contract is part of phase 1.

The handwritten signature image is a
user-supplied PNG and **must not be committed to the repo** — loaded at export time (file
picker) or from the app's Mongo-backed config, embedded only into the appearance stream.

## Validation

- **EU DSS demo validator** (EC digital-building-blocks webapp) — the conformance oracle:
  reports the exact profile (`PAdES-BASELINE-B/T`) and QES determination against the EU
  Trust List. Use at every milestone.
- **Adobe Acrobat Reader** — EUTL enabled by default; I.CA is on the Czech trusted list,
  so a correct signature shows the green banner untouched. The socially decisive test.
- **CI** — `check:signature` script running pyHanko CLI (crypto + trust; it explicitly
  does not check profile conformance) over a committed fixture signed with a throwaway
  cert. Profile conformance via the self-hostable `dss-demonstrations` REST validator,
  run manually at milestones.

## Implementation phases

1. **Placeholder + appearance** — `prepareSignature()` with the stamp-PDF visible widget;
   verify in Adobe Reader that an unsigned field renders correctly. No hardware needed.
2. **CMS assembly + embed** — custom PAdES signer exercised with a self-signed throwaway
   key via WebCrypto; verify the PDF validates cryptographically (as untrusted) in Adobe
   and as `PAdES-BASELINE-B` in the DSS validator. Still no hardware.
3. **Bridge wiring** — `TokenBridge` interface, Fortify implementation, cert discovery UI
   in ExportDialog, sign via token. Requires the smoke-tested token. Result validates
   green.
4. **(Later) B-T timestamp** — TSA proxy route + unsigned attribute embedding.

Phases 1–2 start now; only phase 3 waits on delivery.

## Legal notes

- The handwritten image is cosmetic; the CMS signature is the legal act. Never ship a
  template that embeds the image without the cryptographic layer — it looks signed but is
  a plain SES and trivially copyable.
- QES is equivalent to a handwritten signature (eIDAS art. 25); for B2B acceptance sheets
  this exceeds requirements — which is fine.
- Certificate renewal is annual; signatures made with an expired cert won't validate
  without a timestamp — the argument for eventually doing B-T.

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
