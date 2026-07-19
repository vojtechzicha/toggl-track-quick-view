# PDF export v2 — qualified digital signing

Status: **design approved, implementation blocked on hardware** (waiting for the I.CA token).
Decisions and vendor/product facts below were validated 2026-07-19; re-verify version
numbers and prices if significant time has passed.

## Goal

Signed PDF exports (timesheet / acceptance sheet) where the visible signature block shows
the handwritten signature image next to the certificate details, backed by a real
cryptographic signature — not a pasted image.

Target format: **PAdES** (PDF Advanced Electronic Signature, ETSI EN 319 142) at level
**B-B**, optionally **B-T** (adds an RFC 3161 timestamp). Signature level under eIDAS:
**QES** — qualified certificate on a qualified device (QSCD), legally equivalent to a
handwritten signature EU-wide, shows as trusted (green) in Adobe Reader via the EU Trust
List.

Key constraint that shaped the design: **trust lists (EUTL/AATL) only admit certificates
whose private keys live on certified hardware.** A soft `.p12` certificate can never
validate as trusted; and browsers cannot talk to hardware tokens directly. Therefore the
browser needs a local bridge — that bridge is Fortify.

## Decision

| Component | Choice |
|---|---|
| Hardware | **[I.CA Premium USB](https://www.ica.cz/ica-premium-usb), A7 device** (standard is A6 — A7 must be specified in the order note). Breakable Starcos chip card in a USB token, certified QSCD. ~2 067 CZK incl. VAT with the TWINS certificate bundle (qualified signature + commercial authentication cert). |
| Certificate | I.CA qualified personal certificate (part of TWINS), renewed annually. |
| Middleware | **I.CA SecureStore for macOS** (v8.1 as of writing) — free download, includes a PKCS#11 (Cryptoki) library. |
| Browser bridge | **[Fortify](https://fortifyapp.com)** (Peculiar Ventures) — free, BSD/MIT, exposes PKCS#11 tokens to web pages via a local WebSocket + WebCrypto-like API. v2.1.0 (2025-03) ships a native Apple Silicon `.pkg`. Note: the original `PeculiarVentures/fortify` repo is archived; releases continue at [`PeculiarVentures/fortify-releases`](https://github.com/PeculiarVentures/fortify-releases). |
| Signature assembly | In-browser: PKI.js builds the CMS/PKCS#7 `SignedData`; pdf-lib/@signpdf prepare the signature field and embed the result. All MIT. |

Running costs: token + certificate only. Fortify, SecureStore, and all JS libraries are
free. PAdES-B-B needs no external service at all; B-T needs a TSA (free public RFC 3161
TSAs exist; a Czech *qualified* timestamp from I.CA/PostSignum is a paid service —
optional, decide later).

### Options considered and rejected

- **Soft `.p12` (AES)** — cheapest, pure-JS, but can never validate as trusted (see
  constraint above). Rejected.
- **Bank iD SIGN** — AdES-QC, ~5 CZK/signature, no hardware; but requires a bank
  dependency plus either a direct B2B contract or an aggregator (DigiSign, Signi,
  OKdokument). Rejected for a personal tool; fine fallback if hardware path fails.
- **I.CA RemoteSign** — full QES via API + I.CA mobile app confirmation, PAdES-B-B/B-T
  produced server-side. Solid, but paid service with per-signature flow. Fallback #2.
- **eObčanka + reader** — full QES, cheapest hardware (~400 CZK reader + cert fee), and
  Fortify supports the Czech eID *out of the box* (its driver DB maps the card to
  `/usr/local/lib/eOPCZE/libeop2v1czep11.dylib` on macOS). Not chosen because the signing
  key dies with the ID card, but this is the best zero-new-hardware fallback.

## Validation findings (2026-07-19)

1. Fortify is alive and free: v2.1.0 (March 2025) at `fortify-releases`, including
   `Fortify_2.1.0_arm64.pkg`. License BSD/MIT.
2. I.CA SecureStore for macOS v8.1 is a free download and includes a PKCS#11 component.
3. Fortify's shipped card database (`card.jws`, 82 cards) does **not** contain the I.CA
   Starcos card. Custom cards are supported: add an entry with the card's ATR and the
   SecureStore PKCS#11 dylib path to `~/.fortify/config.json`, restart Fortify
   (see [fortify#439](https://github.com/PeculiarVentures/fortify/issues/439)).
4. The Czech eID (post-7/2018) *is* in the built-in database — relevant for the fallback.
5. The I.CA Premium USB product page does not state OS support and the A7 device is
   non-standard — **confirm A7 + macOS + SecureStore compatibility with I.CA support
   (+420 284 081 930) before ordering.**

## Smoke test — run when the token arrives, before writing any code

1. Install `Fortify_*_arm64.pkg` and I.CA SecureStore for macOS; plug in the token;
   confirm the SecureStore app sees the card and the certificates.
2. Find the PKCS#11 dylib the SecureStore installer placed on disk; check its
   architecture with `file <dylib>`. If it is x86_64-only, the arm64 Fortify build cannot
   load it — install the x64 Fortify build (runs under Rosetta) instead.
3. Read the card's ATR (`opensc-tool --atr`, or from Fortify's log when an unknown card
   is inserted).
4. Add the card to `~/.fortify/config.json` (`cards: [{ name, atr, libraries: [<dylib>] }]`),
   restart Fortify.
5. Open Fortify's demo tools page (tools.fortifyapp.com), approve the pairing, and check
   that the qualified certificate is listed and can sign test data after PIN entry.
6. Verify the token allows raw RSA signing via PKCS#11 (some token profiles restrict key
   use; Firefox/Adobe use the same path, so this is expected to pass).

If step 5–6 fail: fallbacks in order — hand-rolled localhost PKCS#11 helper (same token),
eObčanka + Fortify, I.CA RemoteSign.

## Architecture

Current pipeline (`lib/export/pdf/index.ts`): `toPDF(doc, templateId)` lazy-loads pdfmake
and returns a `Blob`, invoked from `components/export/ExportDialog.tsx`. All client-side —
and signing must stay client-side too, since the private key is on the user's token.

New module `lib/export/pdf/sign/`, appended as an optional post-processing stage:

```
toPDF() Blob
  → prepareSignature(blob, appearance)        [pdf-lib + @signpdf placeholder]
      adds AcroForm signature field + visible widget (handwritten image PNG,
      signer name, date) and a /Contents placeholder; returns bytes + ByteRange
  → fortifySign(byteRangeDigest)              [webcrypto-socket / fortify-webcomponents]
      user approves in Fortify, enters token PIN; raw RSA-SHA256 signature
  → buildCMS(signature, cert, chain)          [PKI.js]
      SignedData with signed attributes: contentType, messageDigest, signingTime,
      signingCertificateV2 (required for PAdES)
  → embedCMS(bytes, cms)                      → PAdES-B-B PDF Blob
  → (optional) RFC 3161 timestamp             → PAdES-B-T
```

Design rules:

- **Signing is optional and additive.** No Fortify detected, or the user skips signing →
  the unsigned export works exactly as today. No regression risk to v1 templates.
- The digest is computed over the prepared PDF's ByteRange **after** pdfmake and the
  placeholder step are completely finished; nothing about the existing generation changes.
- Templates gain a reserved signature box (position config per template) so the visible
  widget lands in an intentional spot. This is the only template-level change.
- The handwritten signature image is a user-supplied PNG and **must not be committed to
  the repo**. Load it at export time (file picker) or from the app's Mongo-backed config;
  it is embedded only into the widget appearance stream.
- The optional TSA call cannot be made from the browser if the TSA lacks CORS — if B-T is
  wanted, add a tiny Next.js API route that proxies the RFC 3161 request (stateless, no
  secrets).

## Implementation phases

1. **Placeholder + appearance** — `prepareSignature()` with visible widget; verify in
   Adobe Reader that an unsigned field renders correctly. Testable with no hardware.
2. **CMS assembly + embed** — sign with a self-signed throwaway key via WebCrypto first;
   verify the PDF validates cryptographically (as untrusted) in Adobe. Still no hardware.
3. **Fortify wiring** — cert discovery UI in ExportDialog, sign via token. Requires the
   smoke-tested token. Result should validate green.
4. **(Optional) B-T timestamp** — TSA proxy route + unsigned attribute embedding.

Phases 1–2 can be built any time; only phase 3 waits on the token.

## Legal notes

- The handwritten image is cosmetic; the CMS signature is the legal act. Never ship a
  template that embeds the image without the cryptographic layer — it looks signed but is
  a plain SES and trivially copyable.
- QES is equivalent to a handwritten signature (eIDAS art. 25); for B2B acceptance
  sheets this exceeds requirements — which is fine.
- Certificate renewal is annual; signatures made with an expired cert won't validate
  without a timestamp, which is the argument for eventually doing B-T.

## References

- I.CA Premium USB: https://www.ica.cz/ica-premium-usb
- I.CA SecureStore (macOS, PKCS#11): https://www.ica.cz/en/secure-store
- Fortify releases: https://github.com/PeculiarVentures/fortify-releases
- Fortify custom card config: https://github.com/PeculiarVentures/fortify/issues/439
- Fortify install help: https://fortifyapp.com/help
- PAdES: ETSI EN 319 142-1
- Bank iD SIGN (fallback): https://bankid.cz/firmy/sign/
- I.CA RemoteSign (fallback): https://www.ica.cz/en/ica-remotesign
- eObčanka macOS software (fallback): https://info.identita.gov.cz/eop/InstalacemacOS.aspx
