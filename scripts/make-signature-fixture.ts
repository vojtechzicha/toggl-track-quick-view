// Regenerates the committed signature fixture. Run with:
//   node scripts/make-signature-fixture.ts
//
// Writes scripts/fixtures/throwaway-signer-cert.pem (derived from the committed
// private key) and scripts/fixtures/signed-report.pdf. Everything that
// would otherwise vary — the certificate's serial and validity, the signing
// instant, the document's contents — is pinned in scripts/signatureFixture.ts,
// so the only thing that moves the fixture is a real change to how signing
// works. That is the point of committing it: `npm run check:signature`
// validates this file, and a diff here is a change worth looking at.
//
// The one thing that is NOT reproducible byte for byte is the PDF itself:
// pdfkit writes a /CreationDate and derives the trailer /ID from it, so a
// regenerated file always differs a little from the committed one. The check
// therefore re-signs and asserts, rather than comparing bytes.

import { buildFixture, CERT_PEM, KEY_PEM, SIGNED_PDF } from './signatureFixture.ts';
import fs from 'node:fs';

if (!fs.existsSync(KEY_PEM)) {
  throw new Error(
    `Missing ${KEY_PEM.pathname}. Generate one with:\n` +
      `  node -e "const c=require('node:crypto');const {privateKey}=c.generateKeyPairSync('rsa',` +
      `{modulusLength:2048});require('node:fs').writeFileSync(process.argv[1],` +
      `privateKey.export({type:'pkcs8',format:'pem'}))" ${KEY_PEM.pathname}`
  );
}

const { signed, certificateDer } = await buildFixture();

const pem = [
  '-----BEGIN CERTIFICATE-----',
  ...(Buffer.from(certificateDer).toString('base64').match(/.{1,64}/g) ?? []),
  '-----END CERTIFICATE-----',
  '',
].join('\n');

fs.writeFileSync(CERT_PEM, pem);
fs.writeFileSync(SIGNED_PDF, signed);

console.log(`✓ wrote ${CERT_PEM.pathname} (${pem.length} bytes)`);
console.log(`✓ wrote ${SIGNED_PDF.pathname} (${signed.length} bytes)`);
