// The @signpdf Signer that produces our PAdES CMS.
//
// @signpdf does the byte-level work (filling /ByteRange, cutting out the
// placeholder, writing the hex CMS back) and hands the Signer the bytes the
// signature covers. This class hashes them and calls ./cms.ts.
//
// @signpdf/signer-p12 is not used: it adds a signed signing-time attribute,
// which PAdES baseline forbids.

import { Signer } from '@signpdf/utils';
import { buildCms, sha256 } from './cms';
import type { TokenBridge } from './bridge';

export interface PadesSignerOptions {
  bridge: TokenBridge;
  certificateId: string;
  certificate: Uint8Array;
  chain: Uint8Array[];
  /** Passed to the bridge so a hardware one can name it in its PIN prompt. */
  documentName?: string;
  /**
   * Fetch an RFC 3161 token over the signature, producing PAdES-B-T. Omitted
   * leaves the signature at B-B.
   */
  timestamp?: (signature: Uint8Array) => Promise<Uint8Array>;
  /**
   * Reports which level was produced. A callback because the CMS is built
   * inside @signpdf's sign() call, so `signPdf` cannot return it.
   */
  onLevel?: (level: 'B-B' | 'B-T', timestampError: Error | null) => void;
}

export class PadesSigner extends Signer {
  // Not a constructor parameter property: Node's type stripping, which the
  // scripts/ checks use, does not support that syntax.
  private readonly options: PadesSignerOptions;

  constructor(options: PadesSignerOptions) {
    super();
    this.options = options;
  }

  /**
   * @param pdfBuffer the concatenated bytes of the signature's ByteRange —
   *   everything except the /Contents placeholder.
   *
   * The `signingTime` @signpdf passes is ignored: in PAdES the claimed time is
   * the signature dictionary's /M, written with the placeholder (./prepare.ts).
   */
  async sign(pdfBuffer: Buffer): Promise<Buffer> {
    const messageDigest = await sha256(new Uint8Array(pdfBuffer));
    let timestampError: Error | null = null;

    const cms = await buildCms({
      certificate: this.options.certificate,
      chain: this.options.chain,
      messageDigest,
      sign: (toBeSigned) =>
        this.options.bridge.signDigest({
          certificateId: this.options.certificateId,
          data: toBeSigned,
          hash: 'SHA-256',
          documentName: this.options.documentName,
        }),
      // A failed timestamp degrades to B-B instead of failing the export: the
      // PIN has been entered and the card has signed by now. `onLevel` reports
      // the outcome so the user is told.
      timestamp: this.options.timestamp
        ? async (signature) => {
            try {
              return await this.options.timestamp!(signature);
            } catch (e) {
              timestampError = e instanceof Error ? e : new Error(String(e));
              return null;
            }
          }
        : undefined,
    });

    this.options.onLevel?.(
      this.options.timestamp && !timestampError ? 'B-T' : 'B-B',
      timestampError
    );
    return Buffer.from(cms);
  }
}
