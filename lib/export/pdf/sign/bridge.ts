// The bridges the app knows about, and the one that needs no hardware.
//
// The interface they implement lives in ./tokenBridge.ts; the hardware one in
// ./fortify.ts. What is here is the WebCrypto bridge and the list itself:
//
//  - WebCryptoBridge — a throwaway key generated in the browser. Not a legal
//    signature and never presented as one: it exists so the whole pipeline runs
//    end to end without a token, with real CMS, real digests and a really
//    verifiable signature that simply chains to nothing anyone trusts.
//  - FortifyBridge — the hardware path, offered only when Fortify is actually
//    running, so nothing silently half-works on a machine without it.

import { ExtensionBridge, type ExtensionBridgeOptions } from './extensionBridge';
import { FortifyBridge, type FortifyBridgeOptions } from './fortify';
import { generateThrowawayKey, type ThrowawayKey, type ThrowawayKeyOptions } from './throwaway';
import {
  TokenBridgeUnavailableError,
  type SignDigestRequest,
  type TokenBridge,
  type TokenCertificate,
} from './tokenBridge';

export {
  TokenBridgeUnavailableError,
  type BridgeReadiness,
  type SignDigestRequest,
  type TokenBridge,
  type TokenCertificate,
} from './tokenBridge';
export { FortifyBridge, FORTIFY_ORIGIN, type FortifyBridgeOptions } from './fortify';
export {
  ExtensionBridge,
  SIGN_BRIDGE_EXTENSION_ID,
  type ExtensionBridgeOptions,
} from './extensionBridge';
export { readCertificateInfo, type CertificateInfo } from './certificateInfo';

// ---- WebCrypto (a throwaway key, no hardware) ----

/**
 * Everything ./throwaway.ts takes: a name for the certificate, and — for the
 * checks — a fixed key, serial and validity, so the committed fixture can be
 * regenerated to the same bytes.
 */
export type WebCryptoBridgeOptions = ThrowawayKeyOptions;

/**
 * A bridge backed by a self-signed key generated with WebCrypto and held in
 * memory for the session.
 *
 * The key is generated once, on the first call, and never persisted: closing
 * the tab throws it away, which is the point. A PDF signed with it validates
 * cryptographically and reports as untrusted, exactly as an unknown signer
 * should.
 */
export class WebCryptoBridge implements TokenBridge {
  readonly id = 'webcrypto';
  readonly label = 'Throwaway key (development)';
  // Generating a key asks nobody anything.
  readonly interactive = false;

  private key: Promise<ThrowawayKey> | null = null;
  // Not a constructor parameter property: node's type stripping, which the
  // scripts/ checks lean on, does not support that syntax.
  private readonly options: WebCryptoBridgeOptions;

  constructor(options: WebCryptoBridgeOptions = {}) {
    this.options = options;
  }

  private material(): Promise<ThrowawayKey> {
    this.key ??= generateThrowawayKey(this.options);
    return this.key;
  }

  async isAvailable(): Promise<boolean> {
    return typeof globalThis.crypto?.subtle?.generateKey === 'function';
  }

  async listCertificates(): Promise<TokenCertificate[]> {
    const { certificateDer, subjectCN, notBeforeMs, notAfterMs } = await this.material();
    return [
      {
        id: this.id,
        subjectCN,
        // Self-signed: the issuer is the subject, and there is no chain.
        issuerCN: subjectCN,
        notBeforeMs,
        notAfterMs,
        der: certificateDer,
        chain: [],
        providerName: 'This browser',
        hardware: false,
        // Self-signed and software-held: not qualified, and saying so is the
        // whole reason the flag exists.
        qualified: false,
        // It does carry digitalSignature | nonRepudiation (./throwaway.ts), so
        // it is the right SHAPE of certificate — just not a trusted one.
        forSignature: true,
      },
    ];
  }

  async signDigest(request: SignDigestRequest): Promise<Uint8Array> {
    if (request.certificateId !== this.id) {
      throw new TokenBridgeUnavailableError(
        `The throwaway bridge holds no certificate "${request.certificateId}".`
      );
    }
    const { privateKey } = await this.material();
    const signature = await globalThis.crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      request.data as unknown as BufferSource
    );
    return new Uint8Array(signature);
  }
}

export interface AvailableBridgeOptions {
  signBridge?: ExtensionBridgeOptions;
  fortify?: FortifyBridgeOptions;
}

/**
 * Every bridge the app knows about, most-preferred first.
 *
 * The throwaway key stays on the list wherever the app runs, including the
 * preview deployment — that is where the pipeline gets exercised without a
 * card in the machine. What keeps it from being mistaken for the real thing is
 * not hiding it but `qualified: false` on the certificate it hands out, which
 * the export dialog says out loud.
 */
export function availableBridges(options: AvailableBridgeOptions = {}): TokenBridge[] {
  // Sign Bridge first: it is the one that is actually maintained, and the only
  // one that can produce a qualified signature. Fortify stays behind it until
  // it is deleted — it reports itself unavailable on any machine where it is
  // not running, which is all of them since it stopped working on macOS 26.
  return [
    new ExtensionBridge(options.signBridge),
    new FortifyBridge(options.fortify),
    new WebCryptoBridge(),
  ];
}
