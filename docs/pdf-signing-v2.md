# PDF export v2 — qualified digital signing

Status: **phases 1–2 implemented** (2026-08-19); hardware ordered (I.CA Premium USB
with the A7 device) and phase 3 waits for it. Vendor/product facts below were validated
2026-08-19 (some directly from downloaded binaries); re-verify versions and prices if
significant time has passed.

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
3. **Bridge wiring** — the Fortify implementation (`FortifyBridge` is a stub that reports
   itself unavailable), cert discovery UI in ExportDialog, sign via token. Requires the
   smoke-tested token. Result validates green. What phase 3 has to fill in:
   `@peculiar/fortify-webcomponents`' provider list behind `listCertificates()` and its
   `crypto.subtle.sign()` behind `signDigest()` — the seam is already the only thing the
   pipeline talks to.
4. **(Later) B-T timestamp** — TSA proxy route + unsigned attribute embedding.

Only phase 3 waits on delivery.

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
