# Qualified PDF signing — technology combination research (2026-08-19)

Purpose: pick the concrete combination of **Czech certification agency + signing hardware +
frontend/backend components** for signed PDF exports, verifying that (a) the hardware works
with the software on macOS/Apple Silicon, (b) the output is a fully valid QES/PAdES
document, and (c) the visible signature design is highly customizable.

This refreshes and deepens `docs/pdf-signing-v2.md` (validated 2026-07-19). The July
decision **holds** — I.CA token + browser bridge + JS PAdES assembly — with several
upgrades, one important correction, and newly verified facts marked **[verified]** below
(source checked this week, some by downloading and inspecting the actual binaries).

## TL;DR — recommended combination

| Layer | Recommendation | Confidence |
|---|---|---|
| Certification agency | **I.CA** — TWINS qualified + commercial cert, via the Premium USB bundle | High — only CA with verified macOS/arm64 middleware |
| Hardware (QSCD) | **I.CA Premium USB, 2 067 CZK** incl. VAT: Starcos 3.7 break-out chip + USB device. Default device is **A6**; request **A7 (USB-C)** in the order note — the only device I.CA explicitly markets as macOS-compatible | High on bundle; medium on "A7 required" (marketing text, no compatibility matrix) |
| Middleware | **I.CA SecureStore for macOS 8.3.1.0** (Jun 2026). PKCS#11 at `/usr/local/lib/pkcs11/libICASecureStorePkcs11.dylib` — **[verified] universal x86_64+arm64 binary**, supports Starcos 3.7 | High — installer downloaded and inspected |
| Browser ↔ token bridge | **Fortify v2.1.0** (native arm64) first; **DIY localhost PKCS#11 helper** as the planned fallback | Medium — Fortify custom-card config is its weak spot; DIY is a proven pattern |
| Signature assembly (JS) | **@signpdf 3.3.0 + @cantoo/pdf-lib 2.9.1 + PKI.js 3.4.0 + @peculiar/asn1-ess** — custom PAdES `Signer`, all active in 2026 | High — every package verified maintained |
| Visible appearance | **Stamp-PDF pattern**: design the signature block with pdfmake itself, embed its page as the widget's appearance XObject | High — validator-neutral, unlimited design freedom |
| Timestamp (B-T, optional) | Free TSA (freetsa.org / DigiCert / CESNET) via a Next.js proxy route; qualified PostSignum stamps (~2.5 CZK each) only if legally wanted | High |
| Validation | EU DSS demo webapp as conformance oracle + pyHanko CLI in CI + Adobe Reader EUTL green check | High |

First-year cost ≈ **2 067 CZK** (token bundle incl. first certificates); renewal ≈ 545 CZK/yr,
online, no branch visit while the cert is valid. All software components are free/open
source except the optional qualified timestamps.

---

## 1. Certification agency

All three accredited Czech QTSPs compared, plus the newer non-CA channels:

| Provider / service | QES cert (incl. VAT) | QSCD hardware | macOS (Apple Silicon) | Remote/cloud QES | Fit |
|---|---|---|---|---|---|
| **I.CA** | 545 CZK/yr (725 online via ZealiD); TWINS same price; Premium USB bundle **2 067 CZK** | Starcos 3.7 card 796 CZK; A5/A6/A7 USB device 726 CZK | **Best**: SecureStore 8.3.1.0, app + PKCS#11 dylib **[verified] universal arm64** | I.CA RemoteSign (PAdES-B-B/B-T server-side, API possible; pricing unpublished) | ✅ **Chosen** |
| **PostSignum** | 440 CZK/1 yr; 1 100 CZK/3 yr (cheapest) | TokenME EVO+SW 895 CZK; eToken 5110CC ~536 CZK | **Blocker**: their own iSignum for macOS states qualified tokens are **not supported** on macOS (support "planned"); token middleware documented Win/Linux only | None | ❌ on a Mac |
| **eIdentity** | 478 CZK/1 yr; 1 434 CZK/3 yr | Not published | Nothing published | None found | ❌ too little info, in-person only, smallest player |
| **eObčanka** (eID card as QSCD) | cert 440 CZK (PostSignum) or 1 271 CZK pkg (I.CA); reader ~200 CZK | eOP chip itself | Official app v3.7.0 but **official warning: card detection may fail on macOS Sonoma/Sequoia/Tahoe**; arm64 status unstated | n/a | ⚠️ fallback only |
| **Bank iD SIGN / podepis.bankid.cz** | free for individuals | none | browser-based | advanced (AdES) signature only — **not QES** | ❌ wrong signature level |
| **Bank iD QSIGN** (new, 3/2025–1/2026) | **free** to end user | remote QSCD at CA | browser/bank app | full QES — but only inside participating services (ČSOB, KB, Moneta, Partners); **no individual API** | ❌ can't integrate |
| **EUDI Wallet (eDoklady)** | expected free | phone | app | mandated to offer free QES for citizens; **not live yet** (EU deadline end of 2026) | 🔮 watch for v3 |

Notes:

- I.CA renewal (následný certifikát) is done online, authenticated by signing with the
  still-valid cert — via SecureStore itself. First issuance needs one branch visit (or
  the 725 CZK ZealiD online route). PostSignum renewal works the same way, but that
  doesn't help while their macOS token support is missing.
- Bank iD QSIGN is the interesting newcomer: free qualified signatures backed by a remote
  QSCD. It is unusable here only because there is no API for an individual's own app —
  signing happens inside a participating service's UI. If that ever opens up (or the EUDI
  wallet ships with an RP interface), a hardware-free v3 becomes possible.

## 2. Hardware & middleware — verified facts

- **I.CA Premium USB, 2 067 CZK incl. VAT** = TWINS certificate (qualified signature +
  commercial auth cert) + break-out Starcos 3.7 chip card + USB device. The bundle ships
  the **A6 (USB-A)** device by default; **A5 (USB-C) or A7 (USB-C)** can be chosen in the
  order comment. Only the **A7** product text lists macOS ("Windows, Linux, macOS,
  Android"). All are ACS CCID-class readers (ACR39T/ACR40T), so A6 probably also works,
  but A7 is the safe order. *(July doc said "standard is A6, request A7" — confirmed.)*
- **SecureStore for macOS**: the website still says v8.1, but the current installer
  **[verified by download]** contains **8.3.1.0 (built 2026-06-12)**. It installs
  `/Applications/SecureStore.app` and `/usr/local/lib/pkcs11/libICASecureStorePkcs11.dylib`;
  `file` shows both are **Mach-O universal (x86_64 + arm64)**. The dylib's strings list
  Starcos 3.0/3.5/3.7 incl. the currently sold 3.7 variants.
- **Consequence**: the July doc's biggest open risk — "is the PKCS#11 dylib arm64?" — is
  **resolved positively**. Native arm64 Fortify (or a native DIY helper) can load it; no
  Rosetta contortions needed. The smoke test shrinks to functional checks (card visible,
  raw signing allowed, Fortify custom-card config works).

## 3. Browser ↔ token bridge

The private key sits on the token; browsers can't reach PKCS#11 directly, so a local
bridge is unavoidable for client-side signing. Options as of 8/2026:

| Option | Maintained? | macOS/arm64 | Works with the I.CA dylib | Raw digest signing | License / cost | Verdict |
|---|---|---|---|---|---|---|
| **Fortify v2.1.0** | App: last release 3/2025 (Tauri rewrite), issues going unanswered; but web SDK (`@peculiar/fortify-webcomponents` 4.2.0) still published **6/2026** | native arm64 pkg | Yes via custom card config (ATR + dylib path) — historically the **flakiest part** (unresolved issues #439, #32: token detected, certs not listed) | Yes — remote WebCrypto `sign()` | open source, free | **Primary** — lowest effort if the card config works; smoke-test before building on it |
| **DIY localhost helper** (Node + `pkcs11js`, or Go/Swift) | you maintain it | you compile arm64 | **Yes, total control** (`C_Sign`, CKM_RSA_PKCS) | Yes | yours | **Fallback #1** — ~days of code; real cost is packaging/notarization. Chrome now shows a one-time Local Network Access permission prompt for HTTPS→localhost; **Safari blocks loopback HTTP from HTTPS pages** → Chrome/Edge/Firefox only, or local-TLS cert |
| **ICAPKIService** (I.CA PKIServiceHost + browser extension) | Yes — the component Czech gov portals use; commercial | Yes (macOS listed; arch unverified) | Exactly its purpose (I.CA cards + macOS keychain) | Unclear — it builds the **whole PAdES itself** (B-B/B-T, visible or invisible), which could replace our CMS assembly | proprietary; pricing via podpora@ica.cz; third parties (e.g. DigiSign) do license it | **Wildcard** — worth one pricing email; would collapse the whole signing stack into one supported component, at the cost of appearance control (unknown) and lock-in |
| **Web eID** (Estonian) | active, gov-backed | yes | **No** — supported cards hardcoded (Baltic/Finnish); Czech support = fork the C++ `libelectronic-id` + distribute own builds | yes (signs supplied hash) | MIT | ❌ effort too high |
| **NexU** (Nowina) | **upstream deleted** ≤6/2025; only community forks | Java | yes (user-supplied PKCS#11) | yes | LGPL | ❌ orphaned |
| hwcrypto.js | archived 3/2025, superseded by Web eID | — | — | — | — | ❌ dead |
| Signer.Digital / SConnect (Thales) | active / unclear | "contact us" for the mac host | PKCS#11 yes / Thales-oriented | advertised / unknown | host terms unpublished / commercial | ❌ vendor-dependency for no gain |
| Web Smart Card API, WebAuthn sign-extension, WebUSB | — | ChromeOS-only IWA / spec draft / CCID blocklisted | — | — | — | ❌ not viable on desktop macOS in 2026 |

Supporting signal that the chain works: **EasySigner** (Czech open-source tool, 7–8/2026
articles on Zdroják/Root.cz) signs PAdES B-B…B-LTA on macOS through the eObčanka PKCS#11
module — the same architecture as our fallback helper, proven this month.

Plan: smoke-test Fortify with the real token first (it's a config file + one afternoon).
If cert listing fails the way issues #439/#32 describe, don't fight it — build the helper.
The app-side code is identical either way except the transport call, so design
`lib/export/pdf/sign/` behind a small `TokenBridge` interface (`listCertificates()`,
`signDigest()`), with Fortify and the helper as two implementations.

## 4. Signature assembly — JS stack (all verified current)

| Package | Version (publish) | Role |
|---|---|---|
| `@signpdf/signpdf` + `@signpdf/placeholder-pdf-lib` + `@signpdf/utils` | 3.3.0 (2025-12) | ByteRange placeholder, signature field/widget, CMS embedding. Supports `subFilter: ETSI.CAdES.detached` (PAdES) and external signing via a custom `Signer` subclass |
| **`@cantoo/pdf-lib`** | 2.9.1 (**2026-08-18**) | Actively maintained drop-in pdf-lib fork: **incremental save designed for signing** (`forIncrementalUpdate`), `drawSvg`, full low-level XObject access. Replaces stalled `pdf-lib` 1.17.1 (2021) |
| `pkijs` (+ `asn1js`) | 3.4.0 (2026-03) | CMS `SignedData` on WebCrypto; RFC 3161 `TimeStampReq/Resp` for B-T |
| `@peculiar/asn1-ess` | 2.9.3 (2026-08-18) | Ready-made `SigningCertificateV2` ASN.1 structure (required PAdES attribute) |

Nothing off-the-shelf produces PAdES-B end-to-end in the browser — the gap is exactly one
custom `Signer` (~150 lines): build the signed attributes, hash them, get the raw
signature from the bridge, splice into `SignerInfo`. Everything else is assembly.

**⚠️ Correction to the July doc** (`pdf-signing-v2.md` architecture sketch): it listed
`signingTime` among the **signed** attributes. PAdES-B **forbids** the signed
signing-time attribute (ETSI EN 319 142-1) — the signing time goes into the signature
dictionary's `/M` entry instead. Signed attributes must be exactly: `content-type`,
`message-digest`, `signing-certificate-v2`. (This also means `@signpdf/signer-p12` is
not PAdES-conformant and stays a dev-only tool for phase 2.)

Other hard-won implementation facts:

- pdfmake 0.3.x sits on pdfkit ^0.19 → classic xref tables, no object streams; pdf-lib
  parses its output cleanly. When re-saving with the placeholder, use
  `save({ useObjectStreams: false })` — object streams break @signpdf's ByteRange logic.
- A **first** signature can be added in a full rewrite (placeholder + appearance before
  final save). If we ever want a **second** signature (e.g. client counter-signs), that
  requires incremental update — which `@cantoo/pdf-lib` supports and original pdf-lib
  doesn't. Another reason for the fork.
- @signpdf runs on Node `Buffer` → needs the standard `buffer` polyfill in the browser
  bundle.
- Avoid `@signpdf/placeholder-plain` (string surgery, known invisible-signature bugs);
  the pdf-lib placeholder is the robust path.
- Rejected all-in-one JS options: `@peculiar/pdf-doc` (AGPL/commercial, ~no adoption),
  `@signature-kit/pdf` (young, Brazil-policy focus, Effect runtime), `@dottedice/pades-pdf-signer`
  (not real PAdES — writes metadata, own README admits Acrobat shows nothing), Nutrient/Apryse
  (commercial browser SDKs, quote-based licensing — overkill for one signer).

## 5. Visible signature design — how customizable can it be?

Very. The visible signature is technically a widget annotation whose `/AP /N` entry is a
**form XObject — an arbitrary PDF content stream**. Validators (Adobe, DSS, pyHanko)
verify bytes and CMS only; **none of them constrain the appearance**. Anything PDF can
render — images with alpha, embedded fonts, vector graphics from SVG — is fair game.

Rules that keep Adobe happy:

- One **flat** XObject; the legacy Adobe n0/n2 layer structure is optional (n1/n3/n4 are
  forbidden since Acrobat 6 anyway). Flat is what non-Adobe tooling produces and Acrobat
  renders it fine.
- The XObject **must carry a `/Resources` dict even if empty** (documented Acrobat quirk;
  @signpdf already defends against it).
- The appearance must be written **before** signing so it's inside the signed ByteRange —
  our pipeline does this by construction.
- Embed (subset) any font used; keep the XObject BBox equal to the widget Rect.
- Render the date in the appearance from the same clock as `/M` — a mismatched cosmetic
  date is legal but looks sloppy in validation UIs.

**Recommended authoring approach — the stamp-PDF pattern**: design the signature block as
a tiny standalone PDF and embed its page as the appearance XObject (`embedPage` in
pdf-lib/cantoo). This is exactly what pyHanko's `StaticStampStyle.from_pdf_file()` does
server-side, and it means the signature block can be designed **with pdfmake itself** —
same fonts, same layout language, same theming as the export templates, previewable in
the ExportDialog before signing, with the handwritten PNG + name + date + certificate CN
composed however we like. Design freedom is then literally "anything the existing template
engine can draw", which satisfies the "highly customizable" requirement with zero new
design tooling.

The acceptance template already reserves a labelled signature box
(`lib/export/pdf/templates.ts` — `signatureBlock`), so the widget Rect config per template
slots in where the July doc planned it.

## 6. Timestamps (PAdES-B-T, optional)

| TSA | Cost | Notes |
|---|---|---|
| freetsa.org | free | alive (2026-03: ECDSA P-384, TSA cert valid to 2040); not qualified |
| DigiCert / Sectigo / Apple / Certum | free | DigiCert SHA-256 only; Sectigo throttled ~15 s |
| **tsa.cesnet.cz** | free | Czech academic TSA — nice fit |
| PostSignum qualified TSA | ~2.5 CZK/stamp (TSA100 pack ≈ 250 CZK excl. VAT) | needed only if the timestamp itself must be *qualified* |
| I.CA qualified TSA | quote-only | — |

No public TSA advertises CORS, and RFC 3161 is a POST with a custom content type →
assume browser-direct calls fail; proxy through a stateless Next.js API route (as planned
in July). Free TSAs give technically valid B-T (signature survives cert expiry); a
*qualified* Czech timestamp is a legal nicety we can add later without redesign.

## 7. Proving the output is "fully accepted"

- **EU DSS demo validator** (ec.europa.eu, digital-building-blocks webapp) — the
  conformance oracle: reports the exact profile (`PAdES-BASELINE-B/T`) and QES
  determination against the EU Trust List. Use during development for every milestone.
- **Adobe Acrobat Reader** — ships EUTL support enabled by default; I.CA is on the CZ
  trusted list, so a correct signature shows the green banner with no user setup. This is
  the acceptance test that matters socially (what the client sees).
- **CI**: pyHanko CLI (`pyhanko sign validate`) checks crypto + trust automatically but
  explicitly not PAdES profile conformance; for profile conformance the self-hostable
  `dss-demonstrations` webapp exposes a REST `validateSignature` endpoint. Suggest: a
  `check:signature` script with pyHanko against a committed test fixture (signed with a
  throwaway cert), DSS run manually at milestones.
- Czech extra: Software602 SecuSign runs a *qualified validation service* under eIDAS —
  useful as a second opinion once, not for CI.

## 8. Risks & open questions

1. **Fortify custom-card config** may fail to list certificates (its known weak spot,
   unresolved upstream; desktop app effectively unmaintained since 3/2025). Mitigated by
   the `TokenBridge` interface + DIY helper fallback. *Probability moderate, impact low
   (days of helper work).* 
2. **A7 vs A6**: "A7 for macOS" rests on marketing copy; any ACS CCID reader likely
   works. Order A7 anyway; if A6 arrives, test before returning.
3. **Raw-signing token profile**: some card profiles restrict `C_Sign` mechanisms.
   Firefox and Adobe use the same PKCS#11 path with these tokens, so expected fine —
   smoke-test item, not a design risk.
4. **Safari**: any localhost-helper path is effectively Chrome/Edge/Firefox-only (Safari
   blocks loopback HTTP from HTTPS pages). Fortify avoids this via its own local-TLS
   trick. Acceptable for a personal tool — flag as a known limitation.
5. **ICAPKIService pricing unknown** — one email to podpora@ica.cz answers whether the
   commercial shortcut is worth considering at all.
6. **I.CA RemoteSign pricing unpublished** — same email; it stays fallback #2 (server-side
   signing, no hardware).
7. Number of consecutive online renewals before re-proofing is required: unpublished.

## 9. What changed vs. `pdf-signing-v2.md` (July)

| July doc | Now |
|---|---|
| SecureStore 8.1, PKCS#11 arch unknown — top risk, "confirm with I.CA support" | **8.3.1.0, universal arm64 [verified from binary]** — risk retired; dylib path known |
| Fortify "alive and free" | More precise: desktop app dormant (last release 3/2025, issues unanswered), web SDK still published 6/2026 → still primary, but fallback promoted to a designed-in interface |
| pdf-lib | **@cantoo/pdf-lib** fork (active, incremental-save-for-signing, drawSvg) |
| CMS signed attrs incl. `signingTime` | **Corrected**: PAdES-B forbids signed signing-time; use `/M` + `signing-certificate-v2` (`@peculiar/asn1-ess`) |
| Appearance: "widget with PNG + name + date" | Upgraded to the **stamp-PDF pattern** — design the block with pdfmake itself, unlimited customization |
| Bank iD SIGN fallback (5 CZK/signature, B2B) | Superseded knowledge: **Bank iD QSIGN** now gives free QES but has no individual API; podepis.bankid.cz is free but AdES-only. Neither integrates → drop from fallback list, note EUDI wallet for the future |
| — | New: TSA landscape incl. free Czech CESNET TSA; CI validation strategy; ICAPKIService identified as the commercial wildcard |

## 10. Decision points for discussion

1. **Order the hardware?** I.CA Premium USB, 2 067 CZK, order note "A7 device". First
   issuance needs one branch visit (or +180 CZK for ZealiD online issuance).
2. **Bridge strategy**: agree on Fortify-first with the `TokenBridge` interface and DIY
   helper as fallback — or skip Fortify and build the helper immediately (more control,
   ~days more work, Chrome-family only)? Optionally: send I.CA the ICAPKIService pricing
   question in parallel.
3. **Timestamps**: ship B-B first and add B-T later via free TSA (recommended), or include
   the TSA proxy route from the start?
4. **Appearance authoring**: confirm the stamp-PDF pattern (signature block designed with
   pdfmake, per-template widget position) as the design mechanism.
5. Implementation phases 1–2 from the July doc (placeholder + appearance; CMS with a
   throwaway soft cert) remain buildable **now**, before the token arrives — only the
   bridge phase waits on hardware.
