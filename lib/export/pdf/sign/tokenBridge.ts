// The interface between the signing pipeline and whatever holds the private key.
//
// A qualified certificate's key lives on certified hardware, which a browser
// cannot reach directly, so signing goes through a local bridge (see
// docs/sign-bridge-plan.md). Everything downstream works against this
// interface only.
//
// In its own module so ./bridge.ts (WebCrypto) and ./extensionBridge.ts
// (hardware) can both import it without a cycle.

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
  /**
   * DER of the rest of the issuing chain, leaf-first, without the signer's own
   * certificate (./cms.ts ships `[signerCert, ...chain]`). Empty when the
   * bridge has none or fetches it on demand through `certificateChain()`.
   */
  chain: Uint8Array[];
  /**
   * Where the key lives (token product name, card, or software store), shown
   * in the picker because the CN alone does not say which.
   */
  providerName: string;
  /** The key is on removable hardware rather than in a software store. */
  hardware: boolean;
  /**
   * The certificate claims to be qualified and on a qualified device, so a
   * signature made with it would be a QES. Read from its qcStatements and
   * policies. Only a validator checking the EU Trust List can confirm it, so
   * false is reliable and true is an expectation.
   */
  qualified: boolean;
  /**
   * Key usage includes nonRepudiation (contentCommitment), which separates a
   * signing certificate from an authentication one.
   *
   * I.CA's TWINS product puts both on the same card, and signing with the
   * authentication certificate gives a file that verifies but is not a QES.
   * This says what the issuer intended; whether this machine can use the key
   * is `hasKey`.
   */
  forSignature: boolean;
  /**
   * The private key is present on the device. An I.CA card also carries about
   * thirty of its issuer's CA certificates without keys, so on real hardware
   * most listed certificates have this false.
   */
  hasKey: boolean;
}

export interface SignDigestRequest {
  certificateId: string;
  /**
   * The bytes to sign: the DER SignedAttributes (see ./cms.ts), not the
   * byte-range digest. The bridge hashes them with `hash` and returns an
   * RSASSA-PKCS1-v1_5 signature, the same contract as WebCrypto's subtle.sign.
   * Over PKCS#11 this means building the DigestInfo and signing with raw
   * CKM_RSA_PKCS, since the card offers no CKM_SHA256_RSA_PKCS.
   */
  data: Uint8Array;
  hash: 'SHA-256';
  /**
   * Document name for a bridge that shows a confirmation before signing.
   * Optional because a bridge holding its own key shows nothing.
   */
  documentName?: string;
}

/**
 * Why a bridge cannot sign yet, in terms the export dialog can act on. Each
 * state has a different fix.
 */
export type BridgeReadiness =
  | { state: 'ready' }
  /** Unsupported browser, or a phone. Installing something will not help. */
  | { state: 'unsupported'; reason: string }
  | { state: 'extension-missing'; installUrl: string }
  | { state: 'helper-missing'; installUrl: string }
  | { state: 'helper-outdated'; have: string; need: string; installUrl: string }
  /** Both halves present; the origin has not been approved at the helper yet. */
  | { state: 'not-paired' }
  /** Reader empty, or the card unreadable. */
  | { state: 'no-token'; reason: string };

export interface TokenBridge {
  readonly id: string;
  /** Shown in the export dialog when the user picks where to sign from. */
  readonly label: string;
  /**
   * Listing certificates shows the user something (a pairing window, a PIN
   * prompt). When true, the dialog lists only after the user asks, not as soon
   * as signing is switched on.
   */
  readonly interactive: boolean;
  /** False means do not offer this bridge. Never throws. */
  isAvailable(): Promise<boolean>;
  /**
   * Why `isAvailable()` is false and what the user can do about it. Optional:
   * without it the dialog says nothing.
   *
   * Must be silent (no pairing, prompt or unlock), because it runs as soon as
   * signing is switched on.
   */
  readiness?(): Promise<BridgeReadiness>;
  listCertificates(): Promise<TokenCertificate[]>;
  signDigest(request: SignDigestRequest): Promise<Uint8Array>;
  /**
   * The issuing chain of one listed certificate, for bridges that leave
   * `chain` empty when listing. signPdf() (./index.ts) calls it for the chosen
   * certificate only.
   */
  certificateChain?(certificateId: string): Promise<Uint8Array[]>;
}

/** Raised when a bridge is asked for something it cannot do yet. */
export class TokenBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenBridgeUnavailableError';
  }
}
