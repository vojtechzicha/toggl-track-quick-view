# PDF export v2: qualified digital signing

Signed PDF exports (timesheets, acceptance sheets) whose visible signature block
shows the handwritten signature image next to the certificate details, backed by a
real cryptographic signature.

## Status (2026-08-27)

| Piece | State |
|---|---|
| Visible stamp, placeholder, widget contract | Done |
| PAdES-B-B CMS | Done. DSS reports `PAdES-BASELINE-B` on the throwaway-key fixture. |
| Hardware signing | Done. A real qualified signature has been made with the I.CA card through Sign Bridge, from `localhost:3000`. |
| PAdES-B-T timestamps | Done. Off unless `TSA_URL` is set. |
| Signing from `track.zicha.dev` | Waiting on Sign Bridge phases 4–5 (packaging, publishing the extension). See [sign-bridge-plan.md](sign-bridge-plan.md). |

Open items:

- Put a card-signed file through the DSS validator. Sign the fixture document
  (`scripts/fixtures/signed-report.pdf`) with the card rather than a client
  timesheet, so no client data goes to a third-party validator. Expected result:
  `Qualification: N/A` becomes a QES determination and `NO_CERTIFICATE_CHAIN_FOUND`
  becomes `TOTAL_PASSED`.
- Decide on a timestamp authority. See [Timestamps](#timestamps-pades-b-t).
- Open Acrobat once on a real machine. The properties Acrobat is fussy about are
  asserted in `check:signature`, but the green banner has not been seen yet.

Vendor facts below were checked in August 2026. Re-verify versions and prices if
much time has passed.

## Target

- Format: **PAdES** (ETSI EN 319 142), level **B-B**, or **B-T** with an RFC 3161
  timestamp.
- Level under eIDAS: **QES**, a qualified certificate on a qualified device (QSCD).
  It is legally equivalent to a handwritten signature EU-wide and shows as trusted
  in Adobe Reader through the EU Trust List with no setup.

Trust lists only admit certificates whose private keys live on certified hardware,
and browsers cannot talk to hardware tokens directly. So signing stays client-side
and goes through a local bridge.

## The stack

| Layer | Choice |
|---|---|
| Certification agency | **I.CA**, TWINS certificate (qualified signature + commercial authentication). 545 CZK/yr renewal, done online from SecureStore while the certificate is valid. |
| Hardware (QSCD) | **I.CA Premium USB** (2 067 CZK incl. VAT, first certificates included): Starcos 3.7 chip card in an ACS ACR40T USB-C reader. |
| Middleware | **I.CA SecureStore for macOS 8.3.1.0**. PKCS#11 library at `/usr/local/lib/pkcs11/libICASecureStorePkcs11.dylib`, universal x86_64 + arm64. |
| Browser bridge | **Sign Bridge**, our own Chrome extension and macOS native host. See [sign-bridge-plan.md](sign-bridge-plan.md) and [Alternatives considered](#alternatives-considered). |
| Signature assembly | **@signpdf 3.3** (placeholder, CMS embedding, `ETSI.CAdES.detached`), **@cantoo/pdf-lib 2.9** (maintained pdf-lib fork with `embedPage` and incremental save), **PKI.js 3.4** (CMS SignedData, RFC 3161 client), **@peculiar/asn1-ess** (`SigningCertificateV2`). All open source. |
| Visible appearance | Stamp-PDF pattern: the block is laid out with pdfmake and embedded as the widget's appearance XObject. |
| Timestamps | Any RFC 3161 TSA through the `/api/timestamp` proxy. |

Running costs are the token and the annual certificate.

### Card and middleware facts

| | |
|---|---|
| Reader | ACS ACR40T ICC Reader |
| ATR | `3bda96ff81b1fe451f0780584943412056342e30ef` (historical bytes read `XICA V4.0`) |
| Token | `ICA Starcos 3.74`, Giesecke & Devrient, PIN 6–8 digits |
| Contents | 31 certificates, 2 with a private key: an RSA-4096 qualified signature certificate from *I.CA EU Qualified CA2/RSA 06/2022*, and the commercial authentication certificate of the TWINS pair. The other 29 are issuer CA certificates. |
| Mechanisms | `CKM_RSA_PKCS` (raw), `CKM_RSA_PKCS_PSS` and separate SHA digests. **No `CKM_SHA256_RSA_PKCS`**, so the host builds the DigestInfo itself and signs with raw `CKM_RSA_PKCS`. Check this first if a signature comes out malformed. |

Homebrew's `opensc` provides `pkcs11-tool`, which queries the card through
SecureStore's module without any of our code:

```
pkcs11-tool --module /usr/local/lib/pkcs11/libICASecureStorePkcs11.dylib -T   # or -O, -M
```

## Architecture

The export pipeline (`lib/export/pdf/index.ts`) renders with pdfmake in the
browser. Signing is an optional stage after it, in `lib/export/pdf/sign/`, loaded by
dynamic import from `lib/export/index.ts`:

```
toPDF() Blob
  → renderAppearance(widget, appearance)     [pdfmake]
      the visible block as a one-page PDF the size of the widget rect
  → prepareSignature(blob, …)                [@cantoo/pdf-lib + @signpdf placeholder]
      signature field, visible widget, /Contents placeholder;
      save({ useObjectStreams: false })
  → @signpdf fills /ByteRange and calls PadesSigner with the covered bytes
  → buildCms(sha256(byteRange), cert, chain) [PKI.js + @peculiar/asn1-ess]
      signed attributes: content-type, message-digest, signing-certificate-v2
      → bridge.signDigest(DER SignedAttributes)   RSASSA-PKCS1-v1_5 / SHA-256, PIN on the card
      → optional RFC 3161 token over the signature value, as an unsigned attribute
  → PAdES-B-B or B-T PDF Blob
```

**What the bridge signs.** In CMS the signed bytes are the DER-encoded
SignedAttributes; the byte-range digest is one attribute inside them. So
`buildCms` calls the bridge in the middle. `signDigest` receives the
SignedAttributes and hashes them itself, as WebCrypto's `subtle.sign` does.

Design rules:

- **Signing is optional and additive.** With no bridge, or signing switched off,
  the export is the template's own bytes. `check:signature` asserts this.
- The digest is computed after pdfmake and the placeholder step have finished.
- Re-save with `useObjectStreams: false`. Object streams move the signature
  dictionary into a compressed stream where @signpdf cannot find it. pdfmake emits
  classic xref tables, which pdf-lib parses cleanly.
- Avoid `@signpdf/placeholder-plain` (fragile). A second signature on a signed file
  would need @cantoo/pdf-lib's incremental save.
- `@signpdf` needs the `buffer` polyfill in the browser. It is installed inside the
  lazily loaded stage.
- `@signpdf/signer-p12` is not PAdES-conformant (it adds a signed signing-time
  attribute), so the signer is our own on PKI.js.
- The claimed signing time goes in the signature dictionary's `/M`, because PAdES
  baseline forbids a signed signing-time attribute.

### Choosing the certificate

A TWINS card holds two certificates for the same person. Signing with the
authentication one gives a file that verifies and shows a signature panel but is not
a QES, with no visible symptom. `TokenCertificate` therefore carries three flags,
all read from the DER in `certificateInfo.ts`:

- `qualified`: qcStatements (QcCompliance + QcSSCD) or a QSCD certificate policy.
- `forSignature`: key usage includes nonRepudiation.
- `hasKey`: the private key is on the device. Reported by the host.

The picker lists only certificates with `hasKey` (otherwise the 29 CA certificates
bury the 2 usable ones), preselects one that is both `qualified` and
`forSignature`, and warns when the chosen one is neither. The flags are claims read
off the certificate: `false` is reliable, `true` is an expectation. The verdict
belongs to a validator checking the Trust List.

Listing is interactive on the hardware bridge (pairing, and possibly a PIN), so the
dialog waits for a *Connect and list certificates* click rather than listing when
signing is switched on. The throwaway bridge lists immediately.

### The issuing chain

The hardware bridge lists certificates with an empty `chain`, and `signPdf()` calls
the optional `certificateChain()` for the chosen certificate only. On Sign Bridge
this needs no round trip: the card carries its issuer's CA certificates, so the
chain is a walk up the list already fetched, matching each certificate's encoded
issuer name against another's encoded subject. The walk stops at a self-issued
certificate and never repeats the leaf, because `buildCms` ships
`[signerCert, ...chain]`. Embedding the chain lets a validator build the path
without fetching over AIA.

### Placeholder size

`/Contents` has to be reserved before anything is signed. @signpdf's
`DEFAULT_SIGNATURE_LENGTH` is 8192 **hex characters**, i.e. 4 KiB of CMS. An RSA-4096
signer certificate (2459 B), its RSA-4096 issuing CA (1806 B) and a 512-byte
signature come to 5317 B, so the first card-signed export failed with
`Signature exceeds placeholder length` after the PIN had been entered.

`signPdf()` now builds the CMS once over a zero digest and a zero signature and
measures it. A CMS's DER length depends only on the sizes of the certificate, the
chain and the signature, not their values. It reserves that plus a 512-byte margin
and the timestamp allowance, doubled for hex encoding.

### One copy of pdf-lib

`@signpdf/placeholder-pdf-lib` does `require('pdf-lib')` while our code imports
`@cantoo/pdf-lib`. `pdf-lib` is aliased to the fork in package.json, but the fork's
exports map answers `require` and `import` with different builds. Two builds mean two
PDFName pools, and pdf-lib keys dictionaries by PDFName identity, so the
placeholder's `/AcroForm` would be invisible to the code that attaches the
appearance. Both specifiers are pinned to the ES build in `next.config.js` (bundle)
and `scripts/resolve-hooks.mjs` (checks). On Node 22 the checks' pin holds only while
no `load` hook is registered: with one, `require()` inside an imported CommonJS module
skips the resolve hooks and the placeholder gets `cjs/` again.

### Two ASN.1 library bugs

Both were found by validators and are worked around in `sign/`:

- `@peculiar/asn1-ess`'s `IssuerSerial` encodes `serialNumber` through `+value`.
  Serials arrive from `@peculiar/asn1-x509` as raw INTEGER bytes, and
  `+arrayBuffer` is `NaN`, so signing-certificate-v2 carried serial 0 and pyHanko
  rejected the signature. `cms.ts` overrides `toASN()` on a subclass.
- PKI.js's `RelativeDistinguishedNames` packs all of `typesAndValues` into one
  multi-valued RDN and does not DER-sort that SET. Validators that re-encode before
  hashing (DSS, via BouncyCastle) then compute a different certificate hash, and
  signing-certificate-v2 stops matching. `throwaway.ts` emits one attribute per RDN.
  Certificates parsed from DER, including the card's, round-trip through PKI.js
  byte-identically and are not affected.

## Visible signature appearance

The appearance is a form XObject on the signature widget. Validators (Adobe, DSS,
pyHanko) verify bytes and CMS and never constrain the appearance, so it can contain
anything: images with alpha, embedded fonts, vectors.

The block is authored with pdfmake as a tiny standalone PDF and embedded with
`embedPdf`. It uses the template's font family when the widget names one
(`SignatureWidget.fontFamily`) and the app's own neutral palette (`STAMP_STYLE`),
since a deployment may have no template pack to take colours from.

Rules that keep Adobe happy:

- One flat XObject. No legacy n0/n2 layering; n1/n3/n4 are forbidden since Acrobat 6.
- The XObject carries a `/Resources` dict even when empty.
- The appearance is written before signing, so it is inside the signed ByteRange.
- Subset-embed fonts. Render the visible date from the same clock as `/M`.
- The XObject's BBox is the widget Rect's *size*: `[0, 0, w, h]` with an identity
  Matrix, as `embedPdf` produces from a stamp page of that size. A viewer maps the
  BBox onto the Rect. `check:signature` asserts equal size, not equal numbers.

**Preview.** The export dialog draws the block in HTML at 1pt = 1px
(`components/export/SignatureBlockPreview.tsx`) from the same appearance values and
`STAMP_STYLE` measurements. Showing the stamp PDF in an iframe does not work: at
this size browsers' built-in PDF viewers ignore `#view=Fit` and zoom in on a corner.

**Which box gets signed.** The app signs as the document's issuer, so the widget
goes in the issuer's box only: *Prepared by* on the report templates' sign-off page
(in the template pack). The *Approved by* box and the acceptance protocol's dashed
box belong to the client countersigning. They carry no widget and keep a date
prompt for whoever signs them by hand or in their own reader. The acceptance
protocol's box looks like the obvious place for our signature and is not.

### Widget placement contract

A block drawn as flowing pdfmake content lands on a page and Y that vary with the
content, and the rendered blob does not record where. So each signable template
declares `signatureWidget: { rect, page }` (`lib/export/pdf/types.ts`): a fixed
rectangle, in pdfmake's top-left coordinates, that the template guarantees is free
on the **last page**. `prepareSignature()` places the widget there, converting to
PDF's bottom-left origin (`widget.ts`).

A template makes the guarantee with two pieces, shown in miniature by the fixture
template in `scripts/signatureFixture.ts`:

- An invisible canvas node as tall as the signature row, so pdfmake's own "does this
  fit" arithmetic pushes the row onto a fresh page. It needs real extents (a
  transparent fill; `lineWidth: 0` still draws a hairline), because pdfmake drops
  zero-extent nodes from the list `pageBreakBefore` walks.
- A `pageBreakBefore` rule keyed on that node's id.

The row itself is drawn with absolutely positioned pieces, so the box's Y needs no
text metrics. Nothing may follow the row in the flow, since it is bottom-anchored.
Keep a clearance (12pt in the pack's report) above the bottom margin: pdfmake
applies its fit test to absolutely positioned content too, and content flush with
the margin is moved to a new page, which then becomes the last page.

### The handwritten image

A user-supplied PNG or JPEG that must never be committed. It is an export identity
field (`lib/exportFields.ts`): a `data:` URL, scoped to the workspace, carried across
devices by settings sync. The dialog stores at most `MAX_SIGNATURE_IMAGE_CHARS`
(256 K base64 characters); a larger scan is used for the current export only.
`.gitignore` covers `signature.png`, `signature-*.png`, `*.signature.png` and
`/signatures/`.

Only PNG and JPEG are accepted, checked by magic bytes. pdfmake embeds images through
PDFKit, which reads nothing else, and an unsupported image makes pdfmake never call
back rather than throw.

## Validation

- **EU DSS demo validator**: the conformance oracle. Reports the profile
  (`PAdES-BASELINE-B/T`) and the QES determination against the EU Trust List. REST
  endpoint: POST `…/webapp-demo/services/rest/validation/validateSignature` with
  `{"signedDocument":{"bytes":"<base64>","name":"x.pdf"}}`. Its privacy notice
  advises against sending sensitive documents, so validate the fixture, not client
  exports.
- **Adobe Acrobat Reader**: EUTL enabled by default, and I.CA is on the Czech trusted
  list. The test that matters socially.
- **`pnpm check:signature`**: builds a signed fixture with the committed throwaway key
  and asserts the structure, then runs pyHanko over the committed
  `scripts/fixtures/signed-report.pdf`. pyHanko checks crypto and trust, not profile
  conformance. Install it with `pipx install pyhanko-cli` (the `pyhanko` package
  alone has no binary), or point `PYHANKO` at it; without it that half is skipped.

**The two validators disagree usefully.** pyHanko validates the bytes it received;
DSS re-encodes through BouncyCastle first. A certificate whose DER is legal but not
canonical passes pyHanko and fails DSS, with misleading symptoms ("the signature is
not intact", "the key size is unknown"). Run both.

### Results so far

Throwaway-key fixture, DSS Demonstration WebApp 6.4, policy "QES AES/QC AES TL
based", 2026-08-22:

```
Signature format:   PAdES-BASELINE-B
Signature scope:    Full PDF (FULL)
On claimed time:    2026-08-19 10:30:00 (UTC)   ← our /M
Indication:         INDETERMINATE
Sub indication:     NO_CERTIFICATE_CHAIN_FOUND
```

No structural complaints. The one failure is expected: the throwaway certificate is
self-signed and chains to no trust anchor. A qualified certificate changes only the
trust decision. pyHanko reports the same fixture VALID against its own certificate as
trust anchor, covering the entire file.

Card-signed export, verified locally on 2026-08-27: leaf and issuing CA in the CMS,
`messageDigest` equal to SHA-256 over the ByteRange, a 512-byte signature verifying
against the certificate's public key, signing-certificate-v2 present, no signing-time
attribute. Not yet through DSS (see Status).

## Timestamps (PAdES-B-T)

Without a timestamp, a validator cannot tell a signature made while the certificate
was valid from one made after it expired, so every B-B signature stops verifying when
the certificate does (a year after issue). Acrobat flags this as "signing time is
from the clock on the signer's computer".

**Shape.** The token covers the signature value, so it can only be fetched after the
card has signed. It goes in as the unsigned attribute `id-aa-signatureTimeStampToken`
(`timestamp.ts`, `cms.ts`). The browser cannot call a TSA directly (no CORS), so
`app/api/timestamp/route.ts` proxies it. `/api/config` reports whether a TSA is
configured, and the dialog only offers a timestamp when one is.

**Checking the answer.** A token over the wrong digest, or replayed from an older
exchange, parses as cleanly as a correct one. The client sends a random nonce and
refuses a response that is not granted, has no token, stamps a different digest,
echoes a different nonce or none, or whose eContent is not a TSTInfo. Each case is
covered in `check:signature` against a locally built TSA.

**A failed timestamp does not fail the export.** By then the PIN has been entered and
the card has signed. The file ships at B-B and the dialog says so and why.

**The reservation is an allowance.** A token cannot be measured without requesting
one, so the placeholder reserves a flat 12 KiB for it. Tokens run 1.5–6 KiB; a real
DigiCert token with a three-certificate chain was 6005 bytes.

**Configuration.** `TSA_URL`, plus `TSA_CREDENTIALS` (HTTP Basic) for a commercial
authority; see `.env.tpl` and [ENVIRONMENT.md](ENVIRONMENT.md). The destination is
server configuration only. A route that forwarded to a URL from the request would be
an SSRF hole. The request carries a hash of the signature value and nothing about the
document.

**Qualified or not.** DSS's verdict on a DigiCert (free TSA) timestamp, 2026-08-27:

```
Qualification:  N/A — Unable to build a certificate chain up to a trusted list!
Indication:     INDETERMINATE / NO_CERTIFICATE_CHAIN_FOUND
                The algorithm RSA with SHA1 with key size 2048 is no longer
                considered reliable for timestamp's CA certificate!
```

The token itself is fine. DSS validates against the EU Trust List, and DigiCert is
not on it; Adobe most likely accepts it, since DigiCert's root is in the AATL. The
SHA-1 line concerns a cross-signed path to `DigiCert Assured ID Root CA`.

So a free TSA does not give a clean DSS result. That needs a qualified TSA on the
EUTL: in the Czech context, I.CA or PostSignum (a few CZK per stamp). Switching is an
environment variable, no code.

**Open question:** whether an untrusted timestamp lowers the DSS verdict compared
with plain B-B. If it does, ship B-B until a qualified TSA is bought.

## Alternatives considered

- **Fortify 2.1** (Peculiar Ventures): dropped. On macOS 26 `FortifyApp` is killed
  by code signing a minute after launch (ad-hoc signed, no Team ID, `dlopen`s native
  addons extracted to a temp directory). The project is dormant (last release
  2025-03). `FortifyBridge` was deleted once Sign Bridge signed with the card.
- **I.CA PKIServiceHost + ICAClientSign** (free, native messaging + extension, does
  PAdES itself): usable only from `localhost` and I.CA's licensed integrators'
  domains, and its host accepts only I.CA's own extension IDs. Production use
  needs a licence (podpora@ica.cz). x86_64 only.
- **DIY localhost HTTP helper**: superseded by native messaging, which has no
  listening port. See [sign-bridge-plan.md](sign-bridge-plan.md).
- **I.CA RemoteSign**: server-side QES with mobile confirmation, no local hardware.
  Pricing unpublished. Still an option if the hardware route becomes a burden.

## Legal notes

- The handwritten image is cosmetic; the CMS signature is the legal act. Never ship a
  template that embeds the image without the cryptographic layer: it looks signed but
  is a plain SES and trivially copied.
- QES is equivalent to a handwritten signature (eIDAS art. 25). For B2B acceptance
  sheets this exceeds the requirement.
- Certificates are renewed yearly. Without a timestamp, a signature stops validating
  when its certificate expires, so a deployment without `TSA_URL` produces signatures
  with that limit.

## References

- I.CA Premium USB: https://www.ica.cz/ica-premium-usb
- I.CA SecureStore (macOS, PKCS#11): https://www.ica.cz/en/secure-store
- ICAPKIService: https://www.ica.cz/ica-pkiservice · I.CA RemoteSign: https://www.ica.cz/en/ica-remotesign
- @signpdf: https://github.com/vbuch/node-signpdf · @cantoo/pdf-lib: https://github.com/cantoo-scribe/pdf-lib
- PKI.js: https://github.com/PeculiarVentures/PKI.js · @peculiar/asn1-ess (SigningCertificateV2)
- PAdES: ETSI EN 319 142-1 (signed attributes; no signed signing-time in baseline profiles)
- EU DSS demo validator: https://ec.europa.eu/digital-building-blocks/DSS/webapp-demo/validation
- pyHanko: https://github.com/MatthiasValvekens/pyHanko
