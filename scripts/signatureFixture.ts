// Shared machinery for the signature fixture: the module resolution the lib/
// modules need under plain node, the fixed throwaway signer, and the one
// document that both scripts/make-signature-fixture.ts and
// scripts/check-signature.ts build.
//
// Importing this module registers the loader hooks, so it has to be imported
// BEFORE anything under lib/ — see the two scripts.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { createPublicKey } from 'node:crypto';
// Type only — the loader hooks installed below are what make the runtime
// imports work, so nothing under lib/ may be imported for its VALUE up here.
import type { PdfTemplate } from '../lib/export/pdf/types.ts';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { installResolveHooks } = (await import('./resolve-hooks.mjs')) as any;

// The module resolution every check in this repository shares: `@/` aliases,
// extensionless relative imports, the template-pack alias, and the single copy
// of pdf-lib the signing stage depends on. Installed by importing this module,
// which is why it has to be imported BEFORE anything under lib/.
installResolveHooks();

export const FIXTURES = new URL('fixtures/', import.meta.url);
export const KEY_PEM = new URL('throwaway-signer-key.pem', FIXTURES);
export const CERT_PEM = new URL('throwaway-signer-cert.pem', FIXTURES);
export const SIGNED_PDF = new URL('signed-report.pdf', FIXTURES);

/**
 * The throwaway signer, pinned in every respect that would otherwise vary, so
 * the certificate comes out byte-identical every time it is derived from the
 * committed key.
 */
export const SIGNER = {
  commonName: 'Throwaway Test Signer (NOT a qualified certificate)',
  organization: 'toggl-track-quick-view test fixtures',
  country: 'CZ',
  notBeforeMs: Date.UTC(2026, 0, 1),
  notAfterMs: Date.UTC(2036, 0, 1),
  serialNumber: new Uint8Array([0x54, 0x51, 0x56, 0x54, 0x45, 0x53, 0x54, 0x01]),
} as const;

/** Fixed signing instant, so /M and the printed date are the same every run. */
export const SIGNED_AT_MS = Date.UTC(2026, 7, 19, 10, 30);

/**
 * The template the fixture signs.
 *
 * Defined here rather than taken from the registry, and that is the point: the
 * app ships the signing machinery but no signable layout of its own — a
 * signature widget is a GUARANTEE about where a block lands, and only a
 * template that reserves the room can make it (see lib/export/pdf/types.ts).
 * The layouts that do are in a private pack, which a clone of this repository
 * does not have. A check that reached for one would test nothing at all on a
 * plain clone, and would be testing someone's private design when it did.
 *
 * So the fixture brings its own: the smallest document that honours the
 * contract — a page of flowed content, an invisible reserve node sized to the
 * signature row, a `pageBreakBefore` rule keyed on it, and the box itself drawn
 * at a fixed absolutePosition on what is therefore always the last page. Both
 * halves of the guarantee, in miniature.
 */
const FIXTURE_PAGE = { width: 595.28, height: 841.89 };
const FIXTURE_MARGIN = 48;
const FIXTURE_BOX = { width: 216, height: 92 };
/** Top of the reserved row, measured up from the bottom margin. */
const FIXTURE_BOX_TOP = FIXTURE_PAGE.height - FIXTURE_MARGIN - 12 - FIXTURE_BOX.height;
const FIXTURE_ANCHOR = 'fixture-signature-anchor';

export const FIXTURE_SIGNATURE_WIDGET = {
  rect: {
    x: FIXTURE_MARGIN,
    y: FIXTURE_BOX_TOP,
    width: FIXTURE_BOX.width,
    height: FIXTURE_BOX.height,
  },
  page: FIXTURE_PAGE,
};

export const TEMPLATE_ID = 'fixture-signable';

/** The base64 body between a PEM's BEGIN/END markers, comments and all ignored. */
const pemBody = (pem: string): Uint8Array => {
  const body = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/.exec(pem);
  if (!body) throw new Error('Not a PEM file.');
  return Buffer.from(body[1].replace(/\s+/g, ''), 'base64');
};

/** The committed private key, as a WebCrypto pair. */
export async function loadFixtureKeyPair(): Promise<CryptoKeyPair> {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
  const pem = fs.readFileSync(KEY_PEM, 'utf8');
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemBody(pem) as unknown as BufferSource,
    algorithm,
    true,
    ['sign']
  );
  // The public half is derived rather than read back from the certificate: the
  // certificate is generated FROM this pair, so it does not exist yet the first
  // time the fixture is made.
  const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  const publicKey = await crypto.subtle.importKey(
    'spki',
    spki as unknown as BufferSource,
    algorithm,
    true,
    ['verify']
  );
  return { privateKey, publicKey };
}

/**
 * A fixed report document: 22 worked days across July 2026, with an hourly rate
 * so the sign-off page carries its investment box (the widest thing above the
 * signature row, and so the case worth fixing in place). Nothing here comes
 * from a clock or a random source.
 */
export function fixtureDoc(): unknown {
  const fromMs = Date.UTC(2026, 6, 1);
  const toMs = Date.UTC(2026, 7, 1);
  const DAY = 24 * 60 * 60 * 1000;
  const days = [];
  for (let i = 0; i < 22; i++) {
    const dateMs = fromMs + i * DAY;
    days.push({
      dateMs,
      label: `Day ${i + 1}`,
      total: 8 * 3600,
      rows: [
        {
          time: '09:00 - 17:00',
          hours: 8 * 3600,
          code: 'DEV',
          billingCode: 'DEV',
          desc: 'Integration work on the ordering service',
          warn: false,
        },
      ],
    });
  }
  return {
    view: 'individual',
    title: 'Fixture Project',
    personName: 'Throwaway Test Signer',
    role: 'Integration architect',
    company: 'Fixture Company s.r.o.',
    client: 'Fixture Client a.s.',
    approver: 'Fixture Approver',
    reference: 'TS-2026-07',
    engagement: 'Contract 2026/001, order 4500123456, for the end customer Fixture Client a.s.',
    rate: 1200,
    currency: 'CZK',
    fromMs,
    toMs,
    multi: false,
    days,
    grandTotal: 22 * 8 * 3600,
  };
}

/**
 * A signature scan stand-in, generated rather than committed.
 *
 * The real image is the user's own and never enters the repository (see
 * .gitignore), but the fixture still has to exercise the image path — an
 * appearance stream with an embedded image is where an XObject or resource
 * mistake would show up. So the check draws its own: a 240x60 8-bit greyscale
 * PNG with a few strokes, built here with a minimal encoder so no image library
 * is needed.
 */
export function syntheticSignaturePng(): string {
  const w = 240;
  const h = 60;
  const raw = Buffer.alloc((w + 1) * h, 0xff);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0; // per-row filter byte: none
  const plot = (x: number, y: number) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    raw[y * (w + 1) + 1 + x] = 0x00;
  };
  for (let x = 0; x < w; x++) {
    // Two overlapping sine strokes and a baseline — deterministic "handwriting".
    const a = 34 + 18 * Math.sin(x / 11) + 7 * Math.sin(x / 4.5);
    const b = 30 - 14 * Math.cos(x / 17);
    for (let t = -1; t <= 1; t++) {
      plot(x, Math.round(a) + t);
      plot(x, Math.round(b) + t);
    }
    plot(x, 48);
  }

  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface BuiltFixture {
  /** The template's own output, untouched by the signing stage. */
  unsigned: Uint8Array;
  /** The same document, signed with the committed throwaway key. */
  signed: Uint8Array;
  /** DER of the certificate the signature was made with. */
  certificateDer: Uint8Array;
  /** The widget rectangle in PDF coordinates, for the structural assertions. */
  rect: [number, number, number, number];
}

/**
 * The fixture template itself. See FIXTURE_SIGNATURE_WIDGET for why it is here
 * and not in the registry.
 */
export function fixtureTemplate(): PdfTemplate {
  return {
    id: TEMPLATE_ID,
    name: 'Fixture (signable)',
    description: 'The smallest document that honours the signature widget contract.',
    signatureWidget: FIXTURE_SIGNATURE_WIDGET,
    build: (doc) => ({
      pageSize: 'A4',
      pageMargins: [FIXTURE_MARGIN, FIXTURE_MARGIN, FIXTURE_MARGIN, FIXTURE_MARGIN],
      content: [
        { text: doc.title || 'Fixture timesheet', fontSize: 16, margin: [0, 0, 0, 12] },
        { text: doc.personName || '—', fontSize: 10, margin: [0, 0, 0, 24] },
        // Enough flow to be a real document rather than an empty page — and,
        // on a long enough range, enough to reach the reserved band and prove
        // the page break rule fires.
        {
          table: {
            widths: ['*', 60],
            body: [
              ['Billing code', 'Seconds'],
              ...(doc.view === 'summary'
                ? doc.weeks.flatMap((week) => week.rows.map((row) => [row.label, String(row.total)]))
                : doc.days.flatMap((day) => day.rows.map((row) => [row.code, String(row.hours)]))),
            ],
          },
          layout: 'lightHorizontalLines',
          fontSize: 8,
        },
        // First half of the guarantee: an invisible node exactly as tall as the
        // signature row, so pdfmake's own fits-on-this-page arithmetic pushes
        // it — and the row with it — onto a fresh page rather than letting the
        // flow run into the reserved band. A real op with real extents, because
        // pdfmake drops zero-extent nodes from the list its page-break rule
        // walks, and a dropped anchor is a silent no-guarantee.
        {
          id: FIXTURE_ANCHOR,
          canvas: [
            {
              type: 'rect',
              x: 0,
              y: 0,
              w: 1,
              h: FIXTURE_BOX.height + 12,
              color: '#ffffff',
              fillOpacity: 0,
            },
          ],
        },
        // The box, at a fixed position so its Y needs no text metrics.
        {
          absolutePosition: { x: FIXTURE_MARGIN, y: FIXTURE_BOX_TOP },
          canvas: [
            {
              type: 'rect',
              x: 0,
              y: 0,
              w: FIXTURE_BOX.width,
              h: FIXTURE_BOX.height,
              lineWidth: 0.5,
              lineColor: '#999999',
              dash: { length: 2.5, space: 2.5 },
            },
          ],
        },
      ],
      // Second half: never let the flow reach into the band the box occupies.
      pageBreakBefore: (node: { id?: string; startPosition: { top: number } }) =>
        node.id === FIXTURE_ANCHOR && node.startPosition.top > FIXTURE_BOX_TOP,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  };
}

/** Render and sign the fixture document with the committed throwaway key. */
export async function buildFixture(): Promise<BuiltFixture> {
  const { renderPdfMake } = await import('../lib/export/pdf/index.ts');
  const sign = await import('../lib/export/pdf/sign/index.ts');

  const template = fixtureTemplate();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = await renderPdfMake(template.build(fixtureDoc() as any));
  const unsigned = new Uint8Array(await blob.arrayBuffer());

  const bridge = new sign.WebCryptoBridge({ ...SIGNER, keyPair: await loadFixtureKeyPair() });
  const [certificate] = await bridge.listCertificates();

  const signedBlob = await sign.signPdf(new Blob([unsigned], { type: 'application/pdf' }), {
    widget: template.signatureWidget!,
    appearance: {
      ...sign.DEFAULT_SIGNATURE_APPEARANCE,
      image: syntheticSignaturePng(),
      signerName: 'Throwaway Test Signer',
      signedAtMs: SIGNED_AT_MS,
      locale: 'en',
    },
    bridge,
    certificate,
    reason: 'Approval of the timesheet',
    location: 'Fixture',
  });

  const { widgetRectToPdf } = sign;
  return {
    unsigned,
    signed: new Uint8Array(await signedBlob.arrayBuffer()),
    certificateDer: certificate.der,
    rect: widgetRectToPdf(
      template.signatureWidget!.rect,
      template.signatureWidget!.page.height
    ),
  };
}

/**
 * A DER certificate with any issuer and subject you like, signed by a key that
 * has nothing to do with either.
 *
 * Chain building matches names and never verifies a signature (see
 * `ExtensionBridge.certificateChain`), so a chain fixture only has to get the
 * NAMES right — and a self-signed generator cannot produce a certificate whose
 * issuer differs from its subject, which is the only interesting case. This
 * builds one directly. It is a fixture and nothing else: the signature on it is
 * meaningless by construction, so it must never leave the checks.
 */
export async function chainFixtureCertificate(subjectCN: string, issuerCN: string): Promise<Uint8Array> {
  const asn1js = await import('asn1js');
  const pkijs = await import('pkijs');
  const { ensureCryptoEngine } = await import('../lib/export/pdf/sign/throwaway.ts');
  ensureCryptoEngine();

  const keyPair = (await globalThis.crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;

  const name = (cn: string) =>
    new pkijs.RelativeDistinguishedNames({
      typesAndValues: [
        new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) }),
      ],
    });

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: 1 });
  certificate.issuer = name(issuerCN);
  certificate.subject = name(subjectCN);
  certificate.notBefore.value = new Date(SIGNED_AT_MS - 86_400_000);
  certificate.notAfter.value = new Date(SIGNED_AT_MS + 86_400_000);
  await certificate.subjectPublicKeyInfo.importKey(keyPair.publicKey);
  await certificate.sign(keyPair.privateKey, 'SHA-256');
  return new Uint8Array(certificate.toSchema(true).toBER(false));
}

export interface FakeTimestampOptions {
  /** SHA-256 the token should claim to cover. Defaults to the real one. */
  imprint?: Uint8Array;
  /** Nonce to echo. Null omits it entirely, which is a rejection case. */
  nonce?: Uint8Array | null;
  /** PKIStatus. 0 granted, 1 grantedWithMods, 2 rejection. */
  status?: number;
  /** Emit a token whose eContent is not a TSTInfo. */
  wrongContentType?: boolean;
  /** Answer with a granted status and no token at all. */
  omitToken?: boolean;
}

/**
 * A TimeStampResp built here, so the timestamp checks need no TSA.
 *
 * Every rejection the client is supposed to make needs a response that is
 * well-formed apart from the one thing being tested — a malformed blob would
 * be caught by the parser and prove nothing about the checks that matter.
 * So this builds a real, signed RFC 3161 token and lets each field be spoiled
 * individually.
 */
export async function fakeTimestampResponse(
  signature: Uint8Array,
  options: FakeTimestampOptions = {}
): Promise<Uint8Array> {
  const asn1js = await import('asn1js');
  const pkijs = await import('pkijs');
  const { ensureCryptoEngine } = await import('../lib/export/pdf/sign/throwaway.ts');
  ensureCryptoEngine();

  const imprint =
    options.imprint ??
    new Uint8Array(
      await globalThis.crypto.subtle.digest(
        'SHA-256',
        signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer
      )
    );

  const status = new pkijs.PKIStatusInfo({ status: options.status ?? 0 });
  if (options.omitToken) {
    return new Uint8Array(new pkijs.TimeStampResp({ status }).toSchema().toBER(false));
  }

  const keyPair = (await globalThis.crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: 7 });
  const name = new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'Fixture TSA' }) }),
    ],
  });
  certificate.issuer = name;
  certificate.subject = name;
  certificate.notBefore.value = new Date(SIGNED_AT_MS - 86_400_000);
  certificate.notAfter.value = new Date(SIGNED_AT_MS + 86_400_000);
  await certificate.subjectPublicKeyInfo.importKey(keyPair.publicKey);
  await certificate.sign(keyPair.privateKey, 'SHA-256');

  const tstInfo = new pkijs.TSTInfo({
    version: 1,
    policy: '1.3.6.1.4.1.99999.1',
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1' }),
      hashedMessage: new asn1js.OctetString({
        valueHex: imprint.buffer.slice(imprint.byteOffset, imprint.byteOffset + imprint.byteLength) as ArrayBuffer,
      }),
    }),
    serialNumber: new asn1js.Integer({ value: 42 }),
    genTime: new Date(SIGNED_AT_MS),
    ...(options.nonce === null
      ? {}
      : {
          nonce: new asn1js.Integer({
            valueHex: (options.nonce ?? new Uint8Array([1, 2, 3, 4])).slice().buffer as ArrayBuffer,
          }),
        }),
  });

  const eContentType = options.wrongContentType ? '1.2.840.113549.1.7.1' : '1.2.840.113549.1.9.16.1.4';
  const signedData = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType,
      eContent: new asn1js.OctetString({ valueHex: tstInfo.toSchema().toBER(false) }),
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: certificate.issuer,
          serialNumber: certificate.serialNumber,
        }),
      }),
    ],
    certificates: [certificate],
  });
  await signedData.sign(keyPair.privateKey, 0, 'SHA-256');

  const token = new pkijs.ContentInfo({
    contentType: '1.2.840.113549.1.7.2',
    content: signedData.toSchema(true),
  });
  return new Uint8Array(
    new pkijs.TimeStampResp({
      status,
      timeStampToken: new pkijs.ContentInfo({ schema: token.toSchema() }),
    })
      .toSchema()
      .toBER(false)
  );
}
