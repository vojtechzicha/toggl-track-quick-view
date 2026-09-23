// Checks the PDF signing stage (lib/export/pdf/sign). Run with:
//   pnpm check:signature
//
//  1. Signs the fixture document with the committed throwaway key and asserts
//     what a validator cares about: widget placement, the appearance stream,
//     exactly the three PAdES signed attributes, message-digest over the byte
//     range, and a signature that verifies. Also asserts that with signing off
//     the export is the template's own bytes.
//
//  2. Runs pyHanko over the committed scripts/fixtures/signed-report.pdf as an
//     independent check (different language, ASN.1 stack and PDF parser).
//     pyHanko checks crypto and trust, not profile conformance; that is the
//     DSS validator's job (docs/pdf-signing-v2.md).
//
// Without the `pyhanko` binary (package `pyhanko-cli`), step 2 is skipped with a
// message so a missing Python tool does not fail the check chain.

import assert from 'node:assert/strict';
// Types only: values come from dynamic imports, which must run after
// ./signatureFixture.ts has installed the resolve hooks.
import type * as PdfLib from '@cantoo/pdf-lib';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, createVerify, X509Certificate } from 'node:crypto';
import {
  buildFixture,
  chainFixtureCertificate,
  fakeTimestampResponse,
  fixtureTemplate,
  CERT_PEM,
  SIGNED_AT_MS,
  SIGNED_PDF,
  SIGNER,
  TEMPLATE_ID,
  fixtureDoc,
  loadFixtureKeyPair,
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
// Without a SignRequest the export path must return the template's own bytes,
// not a pdf-lib round trip of them.
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
  // pdfkit writes the wall clock into /CreationDate and derives the trailer
  // /ID from it. Normalise those two and compare the rest byte for byte.
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

// ---- the stamp's own styling ----
//
// STAMP_STYLE belongs to the app, since a deployment may have no template pack.
// A pack can only name the font family (SignatureWidget.fontFamily).
{
  const { STAMP_STYLE } = await import('../lib/export/pdf/sign/types.ts');
  const { appearanceDocDefinition } = await import('../lib/export/pdf/sign/appearance.ts');
  const { DEFAULT_SIGNATURE_APPEARANCE } = await import('../lib/export/pdf/sign/types.ts');

  const rect = { x: 0, y: 0, width: 216, height: 92 };
  const appearance = { ...DEFAULT_SIGNATURE_APPEARANCE, signerName: 'A Signer' };

  // No family named: pdfmake stays on its bundled Roboto. Guessing a family
  // the template does not load would fail inside the renderer.
  const plain = appearanceDocDefinition(rect, appearance);
  eq(plain.defaultStyle?.font, undefined, 'with no family named the stamp stays on pdfmake\u2019s default');

  const named = appearanceDocDefinition(rect, appearance, 'IBMPlexSans');
  eq(named.defaultStyle?.font, 'IBMPlexSans', 'a template\u2019s named family reaches the stamp');
  eq(
    named.defaultStyle?.fontSize,
    STAMP_STYLE.font.caption,
    'and naming one changes nothing else about the styling'
  );
}

// ---- the stamp fits its box ----
//
// The reserve arithmetic in appearance.ts is an estimate. If it comes out
// short, pdfmake moves the overflow to a second page, only the first becomes
// the appearance, and the date line disappears without error. So the stamp
// must always be exactly one page.
//
// (Text extraction from the signed PDF cannot check this: an annotation's
// appearance stream is not page content.)
{
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const { renderAppearance } = await import('../lib/export/pdf/sign/appearance.ts');
  const { DEFAULT_SIGNATURE_APPEARANCE } = await import('../lib/export/pdf/sign/types.ts');
  const { PDF_TEMPLATES } = await import('../lib/export/pdf/templates.ts');

  // The fixture's signable template plus any from a configured pack. A plain
  // clone has no pack, and without the fixture this loop would assert nothing.
  const signable = [fixtureTemplate(), ...PDF_TEMPLATES.filter((t) => t.signatureWidget)];
  ok(signable.length > 0, 'there is at least one signable template to check the stamp against');

  const LONG_CN = 'A Signer, Some Qualified CA/2016, Prague, Czech Republic';
  for (const tpl of signable) {
    for (const layout of ['image-above', 'image-left'] as const) {
      for (const locale of ['en', 'cs'] as const) {
        for (const reason of ['', 'Approval of the monthly timesheet']) {
          // Pass the template's loader, as signPdf does: a family named in
          // SignatureWidget.fontFamily is only in the VFS once it has run.
          const blob = await renderAppearance(
            tpl.signatureWidget!,
            {
              ...DEFAULT_SIGNATURE_APPEARANCE,
              image: syntheticSignaturePng(),
              signerName: 'A Signer With A Fairly Long Name',
              certificateCN: LONG_CN,
              signedAtMs: SIGNED_AT_MS,
              layout,
              locale,
              reason,
            },
            tpl.loadFonts
          );
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
// PDFKit reads only PNG and JPEG, and pdfmake never calls back on anything
// else. These assert the guard.
{
  const { isEmbeddableSignatureImage } = await import('../lib/export/pdf/sign/types.ts');
  const { appearanceDocDefinition } = await import('../lib/export/pdf/sign/appearance.ts');
  const { DEFAULT_SIGNATURE_APPEARANCE } = await import('../lib/export/pdf/sign/types.ts');

  const dataUrl = (mime: string, bytes: number[]): string =>
    `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
  // "RIFF????WEBP": a format browsers display but PDFKit cannot embed.
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

  // The document definition throws rather than hand pdfmake an image it will
  // never finish rendering.
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

  // Every declared widget must fit its page. Which templates are signable is
  // checked in the pack.
  for (const tpl of [fixtureTemplate(), ...PDF_TEMPLATES.filter((t) => t.signatureWidget)]) {
    const { rect: r, page } = tpl.signatureWidget!;
    ok(widgetRectFits(r, page), `${tpl.id}: the declared rect fits its declared page`);
    ok(r.width > 0 && r.height > 0, `${tpl.id}: the rect has a real area`);
  }

  // A family named by the widget must be loaded by the same template.
  // Otherwise pdfmake throws "Font 'X' in style 'normal' is not defined in the
  // font section" at signing time, after the PIN.
  for (const tpl of PDF_TEMPLATES.filter((t) => t.signatureWidget?.fontFamily)) {
    const family = tpl.signatureWidget!.fontFamily!;
    ok(tpl.loadFonts, `${tpl.id}: names the stamp family ${family}, so it must load fonts`);
    const pack = await tpl.loadFonts!();
    ok(
      Object.keys(pack.fonts).includes(family),
      `${tpl.id}: its own loadFonts() declares ${family}`
    );
  }

  // pdfmake measures down from the top-left, PDF up from the bottom-left.
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

  // The template's reserve node and page-break rule guarantee the last page.
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
  // Without the image XObject the block would print as text alone.
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
  // Everything except the hex string is covered ("covers the entire file" in
  // pyHanko's terms, checked below).
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
  // The reason for the custom signer: @signpdf/signer-p12 fails this.
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
  // @peculiar/asn1-ess's own IssuerSerial encodes raw INTEGER bytes as 0 (see
  // cms.ts).
  const serial = Buffer.from(new X509Certificate(fs.readFileSync(CERT_PEM)).serialNumber, 'hex');
  ok(
    scv2Der.includes(serial),
    'signing-certificate-v2 carries the certificate’s real serial number'
  );

  // The signature is over the DER SignedAttributes re-tagged as a SET, per
  // RFC 5652 §5.4.
  const toBeSigned = Buffer.from(
    new asn1js.Set({ value: attrs.map((a) => a.toSchema()) }).toBER(false)
  );
  const publicKey = new X509Certificate(fs.readFileSync(CERT_PEM)).publicKey;
  const verifier = createVerify('RSA-SHA256').update(toBeSigned);
  ok(
    verifier.verify(publicKey, Buffer.from(signer.signature.valueBlock.valueHexView)),
    'the signature verifies against the certificate’s public key'
  );

  eq(
    signedData.certificates?.length,
    1,
    'the signing certificate is embedded (no chain: the throwaway key is self-signed)'
  );
}

// ---- timestamps (PAdES-B-T) ----
//
// A well-formed token over the wrong data parses as cleanly as a correct one,
// so these checks are mostly about rejection.
{
  const { readToken, requestTimestamp, TimestampError, SIGNATURE_TIMESTAMP_OID, buildCms } =
    await import('../lib/export/pdf/sign/index.ts');

  const signature = new Uint8Array(256).fill(0xab);
  const imprint = new Uint8Array(
    await crypto.subtle.digest('SHA-256', signature.buffer.slice(0) as ArrayBuffer)
  );
  const nonce = new Uint8Array([1, 2, 3, 4]);

  const good = await fakeTimestampResponse(signature, { nonce });
  const token = readToken(good, imprint, nonce);
  ok(token.length > 300, 'a granted response yields a token of a plausible size');
  eq(token[0], 0x30, 'and the token is the DER ContentInfo the attribute carries');

  const rejects = async (raw: Uint8Array, why: string) => {
    checks++;
    await assert.rejects(
      async () => readToken(raw, imprint, nonce),
      (e: unknown) => e instanceof TimestampError,
      why
    );
  };
  // Each case below is a response that parses fine but must be refused.
  const refuses = (raw: Uint8Array, why: string) => {
    checks++;
    assert.throws(() => readToken(raw, imprint, nonce), { name: 'TimestampError' }, why);
  };

  refuses(
    await fakeTimestampResponse(signature, { nonce, status: 2 }),
    'a rejection status is a rejection, however well-formed the rest is'
  );
  refuses(
    await fakeTimestampResponse(signature, { nonce, omitToken: true }),
    'a granted status with no token is refused rather than treated as success'
  );
  refuses(
    await fakeTimestampResponse(signature, { nonce, imprint: new Uint8Array(32).fill(0x11) }),
    'a token over a different digest is a true statement about someone else\u2019s data'
  );
  refuses(
    await fakeTimestampResponse(signature, { nonce: new Uint8Array([9, 9, 9, 9]) }),
    'a token echoing another nonce answers another request'
  );
  refuses(
    await fakeTimestampResponse(signature, { nonce: null }),
    'a token with no nonce cannot be tied to this request, so it may be a replay'
  );
  refuses(
    await fakeTimestampResponse(signature, { nonce, wrongContentType: true }),
    'a token whose eContent is not a TSTInfo is not a timestamp'
  );
  refuses(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]), 'a truncated response is refused');

  // The transport, with the network stubbed: the request is a DER TimeStampReq
  // to our own proxy, and the stub echoes the request's nonce and imprint.
  {
    let sentTo = '';
    let sentBody = new Uint8Array();
    const stub = (async (url: string, init: { body: Uint8Array }) => {
      sentTo = String(url);
      sentBody = new Uint8Array(init.body);
      const pkijs = await import('pkijs');
      const asn1js = await import('asn1js');
      const req = new pkijs.TimeStampReq({
        schema: asn1js.fromBER(sentBody.slice().buffer as ArrayBuffer).result,
      });
      const echoed = new Uint8Array(req.nonce!.valueBlock.valueHexView);
      const sentImprint = new Uint8Array(req.messageImprint.hashedMessage.valueBlock.valueHexView);
      const body = await fakeTimestampResponse(signature, { nonce: echoed, imprint: sentImprint });
      return new Response(body as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    const fetched = await requestTimestamp(signature, { fetchImpl: stub, endpoint: '/api/timestamp' });
    ok(fetched.length > 300, 'a round trip through the transport yields a token');
    eq(sentTo, '/api/timestamp', 'the request goes to our own proxy, never to a TSA directly');
    eq(sentBody[0], 0x30, 'and it is a DER TimeStampReq');

    // A fresh nonce per request, so a caching TSA cannot hand out one token twice.
    const first = new Uint8Array(sentBody);
    await requestTimestamp(signature, { fetchImpl: stub, endpoint: '/api/timestamp' });
    ok(
      !first.every((b, i) => b === sentBody[i]),
      'each request carries a fresh nonce, so no two can be answered by one token'
    );
  }

  // A TSA answering with another nonce fails the request end to end.
  {
    const liar = (async () =>
      new Response((await fakeTimestampResponse(signature, { nonce: new Uint8Array([7, 7]) })) as unknown as BodyInit, {
        status: 200,
      })) as unknown as typeof fetch;
    checks++;
    await assert.rejects(
      () => requestTimestamp(signature, { fetchImpl: liar }),
      { name: 'TimestampError' },
      'a TSA answering with the wrong nonce is refused end to end'
    );
  }

  // The attribute, in the CMS.
  {
    const cmsInput = {
      certificate: certificateDer,
      chain: [] as Uint8Array[],
      messageDigest: new Uint8Array(32).fill(7),
      sign: async () => signature,
    };
    const plain = await buildCms(cmsInput);
    const stamped = await buildCms({
      ...cmsInput,
      timestamp: async (sig: Uint8Array) => {
        const raw = await fakeTimestampResponse(sig, { nonce });
        const imp = new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength) as ArrayBuffer
          )
        );
        return readToken(raw, imp, nonce);
      },
    });

    const pkijs = await import('pkijs');
    const asn1js = await import('asn1js');
    const parse = (der: Uint8Array) =>
      new pkijs.SignedData({
        schema: new pkijs.ContentInfo({
          schema: asn1js.fromBER(der.slice().buffer as ArrayBuffer).result,
        }).content,
      });

    const plainSigner = parse(plain).signerInfos[0];
    eq(
      plainSigner.unsignedAttrs,
      undefined,
      'without a timestamp the SignerInfo carries no unsigned attributes at all'
    );

    const stampedSigner = parse(stamped).signerInfos[0];
    eq(
      stampedSigner.unsignedAttrs?.attributes.map((a) => a.type),
      [SIGNATURE_TIMESTAMP_OID],
      'the token goes in as exactly one unsigned attribute, id-aa-signatureTimeStampToken'
    );
    // Adding the timestamp must not change the signed attributes or the
    // signature, or the signature would no longer verify.
    eq(
      stampedSigner.signedAttrs?.attributes.map((a) => a.type),
      plainSigner.signedAttrs?.attributes.map((a) => a.type),
      'and the signed attributes are untouched by it'
    );
    eq(
      new Uint8Array(stampedSigner.signature.valueBlock.valueHexView),
      new Uint8Array(plainSigner.signature.valueBlock.valueHexView),
      'as is the signature itself'
    );
    ok(stamped.length > plain.length, 'the timestamped CMS is the larger of the two');
  }

  // A failed timestamp still yields a CMS, at B-B: the card has already signed.
  {
    const degraded = await buildCms({
      certificate: certificateDer,
      chain: [],
      messageDigest: new Uint8Array(32).fill(7),
      sign: async () => signature,
      timestamp: async () => null,
    });
    const pkijs = await import('pkijs');
    const asn1js = await import('asn1js');
    const signer = new pkijs.SignedData({
      schema: new pkijs.ContentInfo({
        schema: asn1js.fromBER(degraded.slice().buffer as ArrayBuffer).result,
      }).content,
    }).signerInfos[0];
    eq(
      signer.unsignedAttrs,
      undefined,
      'a timestamp that could not be had leaves a valid B-B signature, not a broken one'
    );
  }
}

// ---- the bridges ----
//
// A token needs a card, a PIN and a person, so this covers what surrounds it:
// which bridges are offered and in what order, and the hardware bridge's chain
// walk.
{
  const { ExtensionBridge, WebCryptoBridge, availableBridges } = await import(
    '../lib/export/pdf/sign/bridge.ts'
  );

  // isAvailable() must answer, not throw, whatever is installed. Outside a
  // browser there is no `chrome` at all.
  const extension = new ExtensionBridge();
  eq(await extension.isAvailable(), false, 'the Sign Bridge bridge reports itself absent outside a browser');
  eq(
    (await extension.readiness()).state,
    'unsupported',
    'and says why, rather than sending someone to install something that would not help'
  );
  eq(extension.interactive, true, 'listing on the hardware bridge prompts, so the dialog waits to be asked');

  const bridges = availableBridges();
  eq(
    bridges.map((b) => b.id),
    ['sign-bridge', 'webcrypto'],
    'the hardware bridge is preferred, and the throwaway one is always last'
  );
  // The dialog offers the first available bridge, so the throwaway key ahead of
  // a token would silently downgrade a qualified signature.
  eq(bridges[bridges.length - 1].id, 'webcrypto', 'the throwaway key is never preferred to hardware');

  // The export dialog warns based on these flags.
  const [throwaway] = await new WebCryptoBridge().listCertificates();
  eq(throwaway.qualified, false, 'the throwaway certificate does not claim to be qualified');
  eq(throwaway.forSignature, true, 'the throwaway certificate carries the non-repudiation bit');
  eq(throwaway.hasKey, true, 'the throwaway key is present, so the certificate is offerable');
  eq(throwaway.hardware, false, 'the throwaway key is not on hardware');

  // ---- the chain walk ----
  //
  // Built from the certificates already listed. It must climb, stop, and never
  // loop.
  const leaf = await chainFixtureCertificate('Leaf Signer', 'Fixture Issuing CA');
  const intermediate = await chainFixtureCertificate('Fixture Issuing CA', 'Fixture Root CA');
  const root = await chainFixtureCertificate('Fixture Root CA', 'Fixture Root CA');
  const unrelated = await chainFixtureCertificate('Somebody Else', 'Some Other CA');

  /** Stock a bridge with the certificates a card would have reported. */
  const bridgeHolding = (entries: [string, Uint8Array][]) => {
    const bridge = new ExtensionBridge();
    const held = (bridge as unknown as {
      certificates: Map<string, { der: Uint8Array; tokenLabel: string }>;
    }).certificates;
    for (const [id, der] of entries) held.set(id, { der, tokenLabel: 'Fixture token' });
    return bridge;
  };

  const full = bridgeHolding([
    ['leaf', leaf],
    ['ca', intermediate],
    ['root', root],
    ['other', unrelated],
  ]);
  const chain = await full.certificateChain('leaf');
  eq(chain.length, 2, 'the walk climbs from the leaf to the root and stops there');
  eq(chain[0], intermediate, 'the issuing CA comes first — the chain is ordered leaf-outwards');
  eq(chain[1], root, 'and its own issuer follows');
  eq(
    chain.some((der) => der === unrelated),
    false,
    'a certificate belonging to no part of this chain is left out of it'
  );

  eq(
    (await bridgeHolding([['leaf', leaf], ['other', unrelated]]).certificateChain('leaf')).length,
    0,
    'a card that carries no issuer of its own yields an empty chain rather than a wrong one'
  );
  eq(
    (await bridgeHolding([['leaf', leaf], ['ca', intermediate]]).certificateChain('nosuch')).length,
    0,
    'an unknown certificate id yields nothing instead of guessing a chain'
  );
  // The CMS ships [signerCert, ...chain], so a repeated leaf would appear twice.
  eq(
    (await full.certificateChain('leaf')).some((der) => der === leaf),
    false,
    'the leaf is not repeated inside its own chain'
  );
}

// ---- what a certificate says about itself ----
//
// The Sign Bridge host sends raw DER only, so every field the picker shows,
// including the qualified claim, comes from certificateInfo.ts.
{
  const { readCertificateInfo } = await import('../lib/export/pdf/sign/certificateInfo.ts');

  const info = readCertificateInfo(certificateDer);
  eq(info.subjectCN, 'Throwaway Test Signer (NOT a qualified certificate)', 'the subject CN is read from the DER');
  eq(info.issuerCN, info.subjectCN, 'a self-signed certificate issues itself');
  ok(info.notBeforeMs > 0 && info.notAfterMs > info.notBeforeMs, 'validity comes out in the right order');
  // throwaway.ts sets digitalSignature | nonRepudiation.
  eq(info.forSignature, true, 'nonRepudiation is detected in the key usage');
  // If this read as qualified, the dialog would stop warning.
  eq(info.qualified, false, 'and a throwaway certificate does not claim to be qualified');

  // Never throws, so one unreadable certificate cannot hide the list.
  const garbage = readCertificateInfo(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]));
  eq(garbage.subjectCN, '', 'unparseable DER yields an empty CN rather than an exception');
  eq(garbage.qualified, false, 'and is not qualified');
  eq(readCertificateInfo(new Uint8Array(0)).notAfterMs, 0, 'empty input is survivable too');
}

// ---- the chain reaches the CMS ----
//
// A hardware bridge lists certificates without chains, and signPdf() asks for
// the chosen one's chain at signing time. Only the hardware path does this, so
// a stand-in bridge here supplies a chain through certificateChain() the way
// ExtensionBridge does.
{
  const sign = await import('../lib/export/pdf/sign/index.ts');
  const asn1js = await import('asn1js');
  const pkijs = await import('pkijs');

  const inner = new sign.WebCryptoBridge({ ...SIGNER, keyPair: await loadFixtureKeyPair() });
  const [cert] = await inner.listCertificates();
  // The signer's own certificate stands in for an issuer: the check is only
  // that whatever certificateChain() returns ends up in the SignedData.
  const issuerStandIn = cert.der;

  let asked = 0;
  const signRequests: { documentName?: string }[] = [];
  const bridge: typeof inner & { certificateChain(id: string): Promise<Uint8Array[]> } =
    Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
      certificateChain: async (id: string) => {
        asked++;
        eq(id, cert.id, 'the chain is asked for by the certificate that is being signed with');
        return [issuerStandIn];
      },
      signDigest: async (request: { documentName?: string }) => {
        signRequests.push(request);
        return inner.signDigest(request as Parameters<typeof inner.signDigest>[0]);
      },
    });

  const template = fixtureTemplate();
  // Copied because Blob's type wants a Uint8Array backed by a plain ArrayBuffer.
  const pdf = new Blob([new Uint8Array(unsigned)], { type: 'application/pdf' });
  const signedWithChain = await sign.signPdf(pdf, {
    widget: template.signatureWidget!,
    appearance: {
      ...sign.DEFAULT_SIGNATURE_APPEARANCE,
      signerName: 'Throwaway Test Signer',
      signedAtMs: SIGNED_AT_MS,
      locale: 'en',
    },
    bridge,
    // Empty, as a hardware bridge lists it.
    certificate: { ...cert, chain: [] },
    documentName: 'Timesheet 2026-08.pdf',
  });

  eq(asked, 1, 'the chain is fetched once, at signing time, not once per listed certificate');
  // The hardware bridge's confirmation window shows this name.
  eq(
    signRequests.map((r) => r.documentName),
    ['Timesheet 2026-08.pdf'],
    'the document name reaches signDigest, for the bridge that shows it before signing'
  );

  const text = Buffer.from(new Uint8Array(await signedWithChain.arrayBuffer())).toString('latin1');
  const range = /\/ByteRange\s*\[\s*\d+\s+(\d+)\s+(\d+)\s+\d+\s*\]/.exec(text);
  ok(range != null, 'the chained signature has a ByteRange');
  // The hex string sits between the two spans, inside < and >.
  const [gapStart, gapEnd] = range!.slice(1).map(Number);
  const hex = text.slice(gapStart + 1, gapEnd - 1).replace(/0+$/, '');
  const der = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
  const parsed = asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength));
  const signedData = new pkijs.SignedData({
    schema: new pkijs.ContentInfo({ schema: parsed.result }).content,
  });
  eq(
    signedData.certificates?.length,
    2,
    'the CMS carries the signer AND what the bridge offered as its chain'
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
        '  Install it with `pipx install pyhanko-cli` (the CLI is a separate package from\n' +
        '  the pyhanko library), or point PYHANKO at the binary.'
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
