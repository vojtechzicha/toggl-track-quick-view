// Checks the PDF signing stage (lib/export/pdf/sign). Run with:
//   npm run check:signature
//
// It does two things:
//
//  1. Builds a signed timesheet report here and now, with the committed
//     throwaway key, and asserts everything a validator would care about:
//     where the widget landed, what the appearance stream looks like, that the
//     signed attributes are EXACTLY the three PAdES allows, that the
//     message-digest really is the digest of the signed byte range, and that
//     the signature verifies against the certificate's public key. It also
//     asserts the load-bearing negative — with signing off, the export is the
//     template's own bytes, unchanged.
//
//  2. Runs pyHanko over the COMMITTED fixture
//     (scripts/fixtures/signed-report.pdf), which is the independent
//     opinion: a different language, a different ASN.1 stack, a different PDF
//     parser. pyHanko checks crypto and trust and explicitly does not check
//     profile conformance — that is the DSS validator's job, run by hand at
//     milestones (see docs/pdf-signing-v2.md).
//
// pyHanko ships as the separate `pyhanko-cli` package these days. When it is
// not installed the script says so and carries on: the assertions in (1) are
// the ones that catch a regression, and a check chain that fails on a missing
// Python tool would just be turned off.

import assert from 'node:assert/strict';
// Types only — the VALUES come from the dynamic import below, because the
// module resolution these modules need is registered by ./signatureFixture.ts
// at run time and a static import would be resolved before that happens.
import type * as PdfLib from '@cantoo/pdf-lib';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, createVerify, X509Certificate } from 'node:crypto';
import {
  buildFixture,
  CERT_PEM,
  SIGNED_AT_MS,
  SIGNED_PDF,
  TEMPLATE_ID,
  fixtureDoc,
  syntheticSignaturePng,
} from './signatureFixture.ts';

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(cond, msg);
};
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepEqual(a, b, msg);
};

const { unsigned, signed, certificateDer, rect } = await buildFixture();

// ---- signing is additive ----
//
// The whole design rests on this: turning signing off has to leave the export
// exactly as it was. So the bytes the export path produces without a
// SignRequest must be the template's own bytes, not a pdf-lib round trip of
// them.
{
  const { toPDF } = await import('../lib/export/pdf/index.ts');
  const { serialize } = await import('../lib/export/index.ts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const direct = new Uint8Array(await (await toPDF(fixtureDoc() as any, TEMPLATE_ID)).arrayBuffer());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viaExport = new Uint8Array(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (await serialize(fixtureDoc() as any, 'pdf', TEMPLATE_ID)).arrayBuffer()
  );
  ok(direct.length === viaExport.length, 'an unsigned export is the same size as toPDF output');
  // pdfkit stamps the wall clock into /CreationDate and derives the trailer's
  // /ID from it, so two renders a second apart differ in exactly those two
  // places. Normalising them is what lets this compare all the rest byte for
  // byte — which is the claim worth making.
  const withoutClock = (bytes: Uint8Array): string =>
    Buffer.from(bytes)
      .toString('latin1')
      .replace(/\(D:\d{14}Z?\)/g, '(D:0)')
      .replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/g, '/ID []');
  eq(
    withoutClock(direct),
    withoutClock(viaExport),
    'an unsigned export is byte-for-byte the template output — signing adds, never rewrites'
  );
  ok(signed.length > unsigned.length, 'signing only ever adds to the document');
}

// ---- the stamp follows the identity system ----
//
// STAMP_STYLE keeps its own copy of the palette so the export dialog's preview
// does not have to import identity.ts (and pdfmake's types with it). A copy is
// only safe while it stays a copy.
{
  const { STAMP_STYLE } = await import('../lib/export/pdf/sign/types.ts');
  const { VZ, F } = await import('../lib/export/pdf/identity.ts');
  const { appearanceDocDefinition } = await import('../lib/export/pdf/sign/appearance.ts');
  const { DEFAULT_SIGNATURE_APPEARANCE } = await import('../lib/export/pdf/sign/types.ts');

  eq(STAMP_STYLE.color.text, VZ.ink, 'the stamp\'s text colour is the identity Ink');
  eq(STAMP_STYLE.color.muted, VZ.secondary, 'its muted colour is the identity Secondary');
  eq(STAMP_STYLE.color.frame, VZ.rule, 'its frame colour is the identity Rule');
  eq(STAMP_STYLE.color.paper, VZ.paper, 'its background is the identity Paper');

  // And the stamp is SET in the identity's typeface — a signature block in a
  // different font reads as pasted onto the report rather than part of it.
  const def = appearanceDocDefinition(
    { x: 0, y: 0, width: 216, height: 76 },
    { ...DEFAULT_SIGNATURE_APPEARANCE, signerName: 'A Signer' }
  );
  eq(def.defaultStyle?.font, F.sans, 'the stamp is set in the identity typeface');
}

// ---- the stamp fits its box ----
//
// The reserve arithmetic in appearance.ts is an estimate, and when it comes out
// a point short the symptom is not a cramped stamp: pdfmake pushes the overflow
// onto a SECOND page, only the first is embedded as the appearance, and the
// date line — the one line a signature stamp cannot do without — disappears
// with no error anywhere. So: the stamp must always be exactly one page.
//
// (Not assertable by extracting text from the signed PDF — an annotation's
// appearance stream is not page content, so it does not come out that way.)
{
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const { renderAppearance } = await import('../lib/export/pdf/sign/appearance.ts');
  const { DEFAULT_SIGNATURE_APPEARANCE } = await import('../lib/export/pdf/sign/types.ts');
  const { PDF_TEMPLATES } = await import('../lib/export/pdf/templates.ts');

  const LONG_CN = 'Vojtěch Zicha, I.CA Qualified 2 CA/2016, Prague, Czech Republic';
  for (const tpl of PDF_TEMPLATES.filter((t) => t.signatureWidget)) {
    for (const layout of ['image-above', 'image-left'] as const) {
      for (const locale of ['en', 'cs'] as const) {
        for (const reason of ['', 'Approval of the monthly timesheet']) {
          const blob = await renderAppearance(tpl.signatureWidget!.rect, {
            ...DEFAULT_SIGNATURE_APPEARANCE,
            image: syntheticSignaturePng(),
            signerName: 'A Signer With A Fairly Long Name',
            certificateCN: LONG_CN,
            signedAtMs: SIGNED_AT_MS,
            layout,
            locale,
            reason,
          });
          const stamp = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
          eq(
            stamp.getPageCount(),
            1,
            `${tpl.id}/${layout}/${locale}${reason ? '/reason' : ''}: the stamp fits one page`
          );
          const { width, height } = stamp.getPage(0).getSize();
          eq(
            [Math.round(width), Math.round(height)],
            [Math.round(tpl.signatureWidget!.rect.width), Math.round(tpl.signatureWidget!.rect.height)],
            `${tpl.id}/${layout}/${locale}: the stamp page is exactly the widget rect`
          );
        }
      }
    }
  }
}

// ---- which signature images can be embedded ----
//
// pdfmake embeds images through PDFKit, which reads PNG and JPEG only — and its
// callback API has no error channel, so anything else does not fail, it simply
// never calls back. Every path an image can take into the appearance is guarded;
// these assert the guard itself.
{
  const { isEmbeddableSignatureImage } = await import('../lib/export/pdf/sign/types.ts');
  const { appearanceDocDefinition } = await import('../lib/export/pdf/sign/appearance.ts');
  const { DEFAULT_SIGNATURE_APPEARANCE } = await import('../lib/export/pdf/sign/types.ts');

  const dataUrl = (mime: string, bytes: number[]): string =>
    `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
  // "RIFF????WEBP" — what the picker used to accept.
  const WEBP = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00];

  ok(isEmbeddableSignatureImage(dataUrl('image/png', PNG)), 'a PNG is embeddable');
  ok(isEmbeddableSignatureImage(dataUrl('image/jpeg', JPEG)), 'a JPEG is embeddable');
  ok(!isEmbeddableSignatureImage(dataUrl('image/webp', WEBP)), 'a WebP is not');
  ok(
    !isEmbeddableSignatureImage(dataUrl('image/png', WEBP)),
    'a WebP calling itself a PNG is not — the bytes decide, not the label'
  );
  ok(!isEmbeddableSignatureImage(''), 'an empty value is not an image');
  ok(!isEmbeddableSignatureImage('https://example.invalid/sig.png'), 'a URL is not a data URL');
  ok(!isEmbeddableSignatureImage('data:image/png,%89PNG'), 'a non-base64 data URL is refused');
  ok(isEmbeddableSignatureImage(syntheticSignaturePng()), 'the fixture image is embeddable');

  // The document definition refuses rather than handing pdfmake something it
  // will silently never finish with.
  assert.throws(
    () =>
      appearanceDocDefinition(
        { x: 0, y: 0, width: 280, height: 95 },
        { ...DEFAULT_SIGNATURE_APPEARANCE, image: dataUrl('image/webp', WEBP) }
      ),
    /PNG or a JPEG/,
    'the appearance refuses an image pdfmake cannot embed'
  );
  checks++;
}

// ---- the widget contract ----
{
  const { PDF_TEMPLATES } = await import('../lib/export/pdf/templates.ts');
  const { widgetRectToPdf, widgetRectFits } = await import('../lib/export/pdf/sign/widget.ts');

  // The report is the document its ISSUER signs; the acceptance protocol's box
  // belongs to the client countersigning it, so it declares no widget.
  const signable = PDF_TEMPLATES.filter((t) => t.signatureWidget);
  eq(
    signable.map((t) => t.id).sort(),
    ['report-cs', 'report-en'],
    'both report languages are signable, and only they are'
  );
  for (const tpl of signable) {
    const { rect: r, page } = tpl.signatureWidget!;
    ok(widgetRectFits(r, page), `${tpl.id}: the declared rect fits its declared page`);
  }

  // The conversion itself: pdfmake measures down from the top-left, PDF up from
  // the bottom-left. Asserted on a rectangle whose answer is obvious by hand.
  eq(
    widgetRectToPdf({ x: 10, y: 20, width: 100, height: 50 }, 800),
    [10, 730, 110, 780],
    'a top-left rect converts to the bottom-left origin'
  );
}

// ---- what a viewer sees ----
{
  const { PDFDocument, PDFArray, PDFDict, PDFName } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.load(signed, { updateMetadata: false });
  const pages = doc.getPages();

  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const fields = acroForm.lookup(PDFName.of('Fields'), PDFArray);
  ok(fields.size() === 1, 'the signed document has exactly one form field');

  const widget = doc.context.lookup(fields.get(0) as PdfLib.PDFRef, PDFDict);
  eq(widget.lookup(PDFName.of('FT'))?.toString(), '/Sig', 'the field is a signature field');

  const widgetRect = widget.lookup(PDFName.of('Rect'), PDFArray);
  const asNumbers = widgetRect.asArray().map((v) => (v as PdfLib.PDFNumber).asNumber());
  eq(asNumbers, rect, 'the widget sits at the rectangle the template declared');

  // The widget must be on the LAST page: that is the half of the contract the
  // template guarantees with its reserve node and page-break rule.
  const lastPageRef = pages[pages.length - 1].ref;
  eq(
    (widget.get(PDFName.of('P')) as PdfLib.PDFRef)?.toString(),
    lastPageRef.toString(),
    'the widget is annotated on the last page'
  );

  // ---- the appearance stream ----
  const ap = widget.lookup(PDFName.of('AP'), PDFDict);
  ok(ap.keys().length === 1, 'the appearance dictionary is flat — /N only, no n0/n2 layering');
  const stream = doc.context.lookup(
    ap.get(PDFName.of('N')) as PdfLib.PDFRef
  ) as unknown as { dict: PdfLib.PDFDict };
  const apDict = stream.dict;
  eq(apDict.lookup(PDFName.of('Subtype'))?.toString(), '/Form', 'the appearance is a form XObject');
  ok(
    apDict.lookup(PDFName.of('Resources'), PDFDict) != null,
    'the appearance carries a /Resources dict (an Acrobat requirement even when empty)'
  );
  const bbox = apDict
    .lookup(PDFName.of('BBox'), PDFArray)
    .asArray()
    .map((v: PdfLib.PDFObject) => (v as PdfLib.PDFNumber).asNumber());
  eq(
    [bbox[2] - bbox[0], bbox[3] - bbox[1]],
    [rect[2] - rect[0], rect[3] - rect[1]],
    'the appearance BBox is the size of the widget rect, so it maps onto it 1:1'
  );
  // The stamp embeds the signature image; if that path broke, the XObject
  // resource would be gone and the block would print as text alone.
  const resources = apDict.lookup(PDFName.of('Resources'), PDFDict);
  ok(
    resources.lookupMaybe(PDFName.of('XObject'), PDFDict) != null,
    'the appearance references the embedded signature image'
  );

  // ---- the signature dictionary ----
  const sig = doc.context.lookup(widget.get(PDFName.of('V')) as PdfLib.PDFRef);
  const sigText = Buffer.from(signed).toString('latin1');
  ok(sig != null, 'the widget points at a signature dictionary');
  ok(
    sigText.includes('/SubFilter /ETSI.CAdES.detached'),
    'the signature declares the PAdES subfilter'
  );
  ok(sigText.includes('/Filter /Adobe.PPKLite'), 'the signature declares the standard filter');
  const m = /\/M\s*\(D:(\d{14})Z?\)/.exec(sigText);
  ok(m != null, 'the signature dictionary records a signing time in /M');
  eq(
    m?.[1],
    new Date(SIGNED_AT_MS)
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14),
    '/M is the same instant the appearance printed'
  );
}

// ---- the ByteRange and the CMS ----
const cms = (() => {
  const text = Buffer.from(signed).toString('latin1');
  const byteRange = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  ok(byteRange != null, 'the signature has a filled-in ByteRange');
  const [a, b, c, d] = byteRange!.slice(1).map(Number);
  eq(a, 0, 'the byte range starts at the beginning of the file');
  eq(c + d, signed.length, 'the byte range runs to the end of the file');
  ok(b < c, 'the gap between the two spans is the /Contents placeholder');

  const covered = Buffer.concat([
    Buffer.from(signed.subarray(a, a + b)),
    Buffer.from(signed.subarray(c, c + d)),
  ]);
  // Everything except the hex string is covered — that is what "the signature
  // covers the entire file" means, and what pyHanko reports separately below.
  eq(covered.length, signed.length - (c - b), 'exactly the placeholder is left out');

  const hex = text.slice(b + 1, c - 1).replace(/0+$/, '');
  const der = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
  return { der, covered };
})();

{
  const asn1js = await import('asn1js');
  const pkijs = await import('pkijs');
  const { PADES_SIGNED_ATTRIBUTE_OIDS } = await import('../lib/export/pdf/sign/cms.ts');

  const parsed = asn1js.fromBER(
    cms.der.buffer.slice(cms.der.byteOffset, cms.der.byteOffset + cms.der.byteLength)
  );
  ok(parsed.offset !== -1, 'the /Contents placeholder holds parseable DER');
  const contentInfo = new pkijs.ContentInfo({ schema: parsed.result });
  eq(contentInfo.contentType, '1.2.840.113549.1.7.2', 'the CMS is a SignedData');

  const signedData = new pkijs.SignedData({ schema: contentInfo.content });
  eq(signedData.signerInfos.length, 1, 'there is exactly one signer');
  ok(
    signedData.encapContentInfo.eContent === undefined,
    'the CMS is DETACHED — the content is the PDF, not a copy inside the signature'
  );
  eq(
    signedData.encapContentInfo.eContentType,
    '1.2.840.113549.1.7.1',
    'the encapsulated content type is id-data'
  );
  eq(
    signedData.digestAlgorithms.map((a) => a.algorithmId),
    ['2.16.840.1.101.3.4.2.1'],
    'SHA-256 throughout'
  );

  const signer = signedData.signerInfos[0];
  const attrs = signer.signedAttrs?.attributes ?? [];
  const oids = attrs.map((a) => a.type).sort();
  eq(
    oids,
    [...PADES_SIGNED_ATTRIBUTE_OIDS].sort(),
    'the signed attributes are exactly content-type, message-digest and signing-certificate-v2'
  );
  // The rule this whole custom signer exists for. @signpdf/signer-p12 fails it.
  ok(
    !oids.includes('1.2.840.113549.1.9.5'),
    'there is NO signed signing-time attribute — PAdES baseline forbids it'
  );

  // message-digest must be the digest of the bytes the ByteRange covers.
  const messageDigest = attrs.find((a) => a.type === '1.2.840.113549.1.9.4');
  const attrDigest = Buffer.from(messageDigest!.values[0].valueBlock.valueHexView);
  eq(
    attrDigest.toString('hex'),
    createHash('sha256').update(cms.covered).digest('hex'),
    'message-digest is the SHA-256 of the signed byte range'
  );

  // signing-certificate-v2 must identify the certificate that actually signed.
  const scv2 = attrs.find((a) => a.type === '1.2.840.113549.1.9.16.2.47');
  const scv2Der = Buffer.from(scv2!.values[0].toBER(false));
  const certHash = createHash('sha256').update(Buffer.from(certificateDer)).digest();
  ok(
    scv2Der.includes(certHash),
    'signing-certificate-v2 carries the SHA-256 of the signing certificate'
  );
  // The serial has to survive the encoding — @peculiar/asn1-ess encodes it as 0
  // if the raw INTEGER bytes are handed to its own IssuerSerial (see cms.ts).
  const serial = Buffer.from(new X509Certificate(fs.readFileSync(CERT_PEM)).serialNumber, 'hex');
  ok(
    scv2Der.includes(serial),
    'signing-certificate-v2 carries the certificate’s real serial number'
  );

  // Finally: does it verify? The signature is over the DER SignedAttributes
  // re-tagged as a SET, per RFC 5652 §5.4.
  const toBeSigned = Buffer.from(
    new asn1js.Set({ value: attrs.map((a) => a.toSchema()) }).toBER(false)
  );
  const publicKey = new X509Certificate(fs.readFileSync(CERT_PEM)).publicKey;
  const verifier = createVerify('RSA-SHA256').update(toBeSigned);
  ok(
    verifier.verify(publicKey, Buffer.from(signer.signature.valueBlock.valueHexView)),
    'the signature verifies against the certificate’s public key'
  );

  // The certificate travels with the signature, or nobody can check any of this.
  eq(
    signedData.certificates?.length,
    1,
    'the signing certificate is embedded (no chain: the throwaway key is self-signed)'
  );
}

// ---- the committed fixture, through pyHanko ----
{
  ok(fs.existsSync(SIGNED_PDF), 'the signed fixture is committed');
  ok(fs.existsSync(CERT_PEM), 'the throwaway certificate is committed');

  const pyhanko =
    process.env.PYHANKO ??
    (spawnSync('pyhanko', ['--help'], { stdio: 'ignore' }).error ? '' : 'pyhanko');
  if (!pyhanko) {
    console.log(
      'ℹ pyhanko not found — skipping the independent validation of ' +
        `${SIGNED_PDF.pathname}.\n` +
        '  Install it with `pipx install pyhanko-cli` (the CLI ships separately from the\n' +
        '  pyhanko library these days), or point PYHANKO at the binary.'
    );
  } else {
    const run = spawnSync(
      pyhanko,
      [
        'sign',
        'validate',
        '--pretty-print',
        '--trust',
        CERT_PEM.pathname,
        SIGNED_PDF.pathname,
      ],
      { encoding: 'utf8' }
    );
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    ok(run.status === 0, `pyhanko validated the committed fixture:\n${output}`);
    ok(
      /The signature is judged VALID/.test(output),
      `pyhanko judged the committed fixture VALID:\n${output}`
    );
    ok(
      /covers the entire file/.test(output),
      `pyhanko reports the signature covers the whole fixture:\n${output}`
    );
  }
}

console.log(`✓ ${checks} signature checks passed`);
