// The seam between the signing pipeline and whatever holds the private key.
//
// A qualified certificate's key lives on certified hardware, and a browser
// cannot talk to a PKCS#11 token directly — so signing goes through a local
// bridge (Fortify, or a small localhost helper; see docs/pdf-signing-v2.md).
// Which one is a deployment detail, and the pipeline must not care: everything
// downstream of here works against this interface alone.
//
// Two implementations live in this module:
//
//  - WebCryptoBridge — a throwaway key generated in the browser. Not a legal
//    signature and never presented as one: it exists so the whole pipeline runs
//    end to end today, with real CMS, real digests and a really verifiable
//    signature that simply chains to nothing anyone trusts.
//  - FortifyBridge — the phase-3 implementation, stubbed. It reports itself
//    unavailable, so the export dialog offers the throwaway path and nothing
//    silently half-works while the token is in the post.

import { generateThrowawayKey, type ThrowawayKey } from './throwaway';

export interface TokenCertificate {
  /** Stable within a bridge session; what signDigest() selects on. */
  id: string;
  /** Subject CN, for the picker and for the visible stamp. */
  subjectCN: string;
  issuerCN: string;
  notBeforeMs: number;
  notAfterMs: number;
  /** DER of the certificate itself. */
  der: Uint8Array;
  /** DER of the issuing chain, leaf-first; empty when the bridge has none. */
  chain: Uint8Array[];
}

export interface SignDigestRequest {
  certificateId: string;
  /**
   * The bytes to be signed: the DER SignedAttributes (see ./cms.ts), NOT the
   * byte-range digest. The bridge hashes them with `hash` and produces an
   * RSASSA-PKCS1-v1_5 signature — the same contract WebCrypto's subtle.sign and
   * Fortify's remote crypto expose, and the one PKCS#11 reaches through
   * CKM_SHA256_RSA_PKCS.
   */
  data: Uint8Array;
  hash: 'SHA-256';
}

export interface TokenBridge {
  readonly id: string;
  /** Shown in the export dialog when the user picks where to sign from. */
  readonly label: string;
  /** False = do not offer this bridge; never throws. */
  isAvailable(): Promise<boolean>;
  listCertificates(): Promise<TokenCertificate[]>;
  signDigest(request: SignDigestRequest): Promise<Uint8Array>;
}

/** Raised when a bridge is asked for something it cannot do yet. */
export class TokenBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenBridgeUnavailableError';
  }
}

// ---- WebCrypto (phase 2: a throwaway key, no hardware) ----

export interface WebCryptoBridgeOptions {
  /** CN of the generated certificate. Defaults to a clearly-marked test name. */
  commonName?: string;
  organization?: string;
  country?: string;
  /** Fixed validity, so a regenerated fixture is byte-identical. */
  notBeforeMs?: number;
  notAfterMs?: number;
  /** Fixed serial, same reason. */
  serialNumber?: Uint8Array;
}

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

// ---- Fortify (phase 3: the real token) ----

const PHASE_3 =
  'Signing with the hardware token is not wired up yet (phase 3 of ' +
  'docs/pdf-signing-v2.md). Use the throwaway key until the token and its ' +
  'Fortify bridge have been smoke-tested.';

/**
 * Placeholder for the Fortify implementation.
 *
 * Left as a stub deliberately: the pairing flow, certificate discovery and PIN
 * prompt all have to be tried against the real card before they can be written
 * with any confidence, and a speculative implementation would be indis-
 * tinguishable from a working one until the moment it mattered. What phase 3
 * has to fill in is `@peculiar/fortify-webcomponents`' provider list behind
 * listCertificates() and its crypto.subtle.sign() behind signDigest().
 */
export class FortifyBridge implements TokenBridge {
  readonly id = 'fortify';
  readonly label = 'Hardware token via Fortify';

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async listCertificates(): Promise<TokenCertificate[]> {
    throw new TokenBridgeUnavailableError(PHASE_3);
  }

  async signDigest(): Promise<Uint8Array> {
    throw new TokenBridgeUnavailableError(PHASE_3);
  }
}

/** Every bridge the app knows about, most-preferred first. */
export function availableBridges(): TokenBridge[] {
  return [new FortifyBridge(), new WebCryptoBridge()];
}
