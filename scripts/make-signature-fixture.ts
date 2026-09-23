// Regenerates the committed signature fixture. Run with:
//   pnpm make:signature-fixture
//
// Writes scripts/fixtures/throwaway-signer-cert.pem (derived from the committed
// private key) and scripts/fixtures/signed-report.pdf. Certificate serial and
// validity, signing time and document content are pinned in
// scripts/signatureFixture.ts, so the fixture changes only when signing does.
// `pnpm check:signature` runs pyHanko over the committed PDF.
//
// The PDF is not byte-reproducible: pdfkit writes the current /CreationDate and
// derives the trailer /ID from it. The check therefore signs afresh and
// asserts, instead of comparing bytes.

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
