// The @signpdf Signer that produces our PAdES CMS.
//
// @signpdf owns the byte-level work — rewriting /ByteRange, cutting the
// placeholder out, hexing the result back in — and hands a Signer the exact
// bytes the signature covers. All this class does is hash them and call
// ./cms.ts, which is why the whole PAdES-specific part of the pipeline is a
// hundred lines rather than a fork of a library.
//
// @signpdf/signer-p12 is NOT used on this path: it inserts a signed signing-
// time attribute, which the PAdES baseline profiles forbid. It stays useful as
// a cross-check when something looks wrong, and nowhere else.

import { Signer } from '@signpdf/utils';
import { buildCms, sha256 } from './cms';
import type { TokenBridge } from './bridge';

export interface PadesSignerOptions {
  bridge: TokenBridge;
  certificateId: string;
  certificate: Uint8Array;
  chain: Uint8Array[];
}

export class PadesSigner extends Signer {
  // Spelled out rather than declared as a constructor parameter property: the
  // scripts/ checks run these modules straight through node's type stripping,
  // which rejects that syntax.
  private readonly options: PadesSignerOptions;

  constructor(options: PadesSignerOptions) {
    super();
    this.options = options;
  }

  /**
   * @param pdfBuffer the concatenated bytes of the signature's ByteRange —
   *   everything except the /Contents placeholder.
   *
   * The `signingTime` @signpdf offers is deliberately ignored: in PAdES the
   * claimed time is the signature dictionary's /M entry, written when the
   * placeholder was added (see ./prepare.ts), not a signed attribute.
   */
  async sign(pdfBuffer: Buffer): Promise<Buffer> {
    const messageDigest = await sha256(new Uint8Array(pdfBuffer));
    const cms = await buildCms({
      certificate: this.options.certificate,
      chain: this.options.chain,
      messageDigest,
      sign: (toBeSigned) =>
        this.options.bridge.signDigest({
          certificateId: this.options.certificateId,
          data: toBeSigned,
          hash: 'SHA-256',
        }),
    });
    return Buffer.from(cms);
  }
}
