// Shared machinery for the signature fixture: the module resolution the lib/
// modules need under plain node, the fixed throwaway signer, and the one
// document that both scripts/make-signature-fixture.ts and
// scripts/check-signature.ts build.
//
// Importing this module registers the loader hooks, so it has to be imported
// BEFORE anything under lib/ — see the two scripts.

import { registerHooks } from 'node:module';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createPublicKey } from 'node:crypto';

const ROOT = new URL('../', import.meta.url);

/**
 * The app is bundled by Next, which resolves extensionless relative imports,
 * the `@/` alias and package `exports` maps. Node resolves none of those the
 * same way, and one of them is load-bearing rather than cosmetic:
 *
 * `pdf-lib` is an ALIAS for @cantoo/pdf-lib (package.json), and its exports map
 * answers `require` with cjs/ and `import` with es/. @signpdf/placeholder-pdf-lib
 * requires it while lib/export/pdf/sign imports it, so the two halves would get
 * two module instances — two PDFName pools, two PDFDict classes — and pdf-lib
 * keys dictionaries by PDFName IDENTITY, so the placeholder's /AcroForm would be
 * invisible to the code that has to find it. Both specifiers are pinned to the
 * ES build here, exactly as next.config.js pins them for the bundle.
 */
const PDF_LIB = new URL('node_modules/@cantoo/pdf-lib/es/index.js', ROOT).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'pdf-lib' || specifier === '@cantoo/pdf-lib') {
      return { url: PDF_LIB, shortCircuit: true };
    }
    // pdfmake's browser bundle, as lib/export/pdf/index.ts asks for it.
    if (specifier.startsWith('pdfmake/build/') && !specifier.endsWith('.js')) {
      return next(`${specifier}.js`, context);
    }
    if (specifier.startsWith('@/')) {
      return { url: new URL(`${specifier.slice(2)}.ts`, ROOT).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        const url = new URL(specifier + suffix, context.parentURL);
        if (fs.existsSync(url)) return { url: url.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
});

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

export const TEMPLATE_ID = 'report-en';

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

/** Render and sign the fixture document with the committed throwaway key. */
export async function buildFixture(): Promise<BuiltFixture> {
  const { toPDF } = await import('../lib/export/pdf/index.ts');
  const { getTemplate } = await import('../lib/export/pdf/templates.ts');
  const sign = await import('../lib/export/pdf/sign/index.ts');

  const template = getTemplate(TEMPLATE_ID);
  if (!template.signatureWidget) {
    throw new Error(`Template ${TEMPLATE_ID} no longer declares a signature widget.`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = await toPDF(fixtureDoc() as any, TEMPLATE_ID);
  const unsigned = new Uint8Array(await blob.arrayBuffer());

  const bridge = new sign.WebCryptoBridge({ ...SIGNER, keyPair: await loadFixtureKeyPair() });
  const [certificate] = await bridge.listCertificates();

  const signedBlob = await sign.signPdf(new Blob([unsigned], { type: 'application/pdf' }), {
    widget: template.signatureWidget,
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
    rect: widgetRectToPdf(template.signatureWidget.rect, template.signatureWidget.page.height),
  };
}
