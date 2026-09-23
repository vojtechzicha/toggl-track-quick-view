// The list of bridges, and the WebCrypto bridge.
//
//  - ExtensionBridge (./extensionBridge.ts): the card, through the Sign Bridge
//    extension and native host. The only one that can make a qualified
//    signature.
//  - WebCryptoBridge: a throwaway key generated in the browser, so the whole
//    pipeline runs without a token. Its signatures verify but chain to nothing
//    trusted.

import { ExtensionBridge, type ExtensionBridgeOptions } from './extensionBridge';
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
export {
  ExtensionBridge,
  SIGN_BRIDGE_EXTENSION_ID,
  type ExtensionBridgeOptions,
} from './extensionBridge';
export { readCertificateInfo, type CertificateInfo } from './certificateInfo';

// ---- WebCrypto (a throwaway key, no hardware) ----

/**
 * Options for ./throwaway.ts. The checks pass a fixed key, serial and validity
 * so the committed fixture regenerates to the same bytes.
 */
export type WebCryptoBridgeOptions = ThrowawayKeyOptions;

/**
 * A self-signed key generated with WebCrypto on first use and kept in memory
 * only; closing the tab discards it. A PDF signed with it verifies and reports
 * an untrusted signer.
 */
export class WebCryptoBridge implements TokenBridge {
  readonly id = 'webcrypto';
  readonly label = 'Throwaway key (development)';
  readonly interactive = false;

  private key: Promise<ThrowawayKey> | null = null;
  // Not a constructor parameter property: Node's type stripping, which the
  // scripts/ checks use, does not support that syntax.
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
        qualified: false,
        // ./throwaway.ts sets digitalSignature | nonRepudiation.
        forSignature: true,
        hasKey: true,
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
}

/**
 * Every bridge the app knows about, most preferred first.
 *
 * The throwaway key is offered on every deployment, so the pipeline can be
 * exercised without a card. Its certificate reports `qualified: false`, and
 * the export dialog warns about that.
 */
export function availableBridges(options: AvailableBridgeOptions = {}): TokenBridge[] {
  return [new ExtensionBridge(options.signBridge), new WebCryptoBridge()];
}
