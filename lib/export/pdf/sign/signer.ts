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
  /** Passed to the bridge so a hardware one can name it in its PIN prompt. */
  documentName?: string;
  /**
   * Fetch an RFC 3161 token over the signature, producing PAdES-B-T. Omitted
   * leaves the signature at B-B.
   */
  timestamp?: (signature: Uint8Array) => Promise<Uint8Array>;
  /**
   * Told what level came out, once it is known.
   *
   * `signPdf` cannot return it: the CMS is built inside a callback @signpdf
   * owns, and by the time it returns a Blob the timestamp has either happened
   * or been given up on. The caller needs to know which, because the whole
   * difference between B-B and B-T is invisible in the file's name.
   */
  onLevel?: (level: 'B-B' | 'B-T', timestampError: Error | null) => void;
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
      // A failed timestamp degrades to B-B instead of failing the export, and
      // that is a deliberate choice about something already spent: by the time
      // this runs the person has entered a PIN and the card has signed, and a
      // TSA that is down must not cost them that. Nobody is told they have a
      // timestamp they do not have — `onLevel` reports what actually happened.
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
