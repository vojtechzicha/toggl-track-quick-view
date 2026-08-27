// The seam between the signing pipeline and whatever holds the private key.
//
// A qualified certificate's key lives on certified hardware, and a browser
// cannot talk to a PKCS#11 token directly — so signing goes through a local
// bridge (see docs/sign-bridge-plan.md). Which one is a deployment detail, and
// the pipeline must not care: everything downstream of here works against this
// interface alone.
//
// The contract lives in its own module rather than beside an implementation
// because both implementations need it: ./bridge.ts holds the WebCrypto one
// and ./extensionBridge.ts the hardware one, and having either import the
// other's file for the interface would be a cycle.

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
   * DER of the REST of the issuing chain, leaf-first — the signer's own
   * certificate is not repeated here (see ./cms.ts, which ships
   * `[signerCert, ...chain]`). Empty when the bridge has none, and empty when
   * the bridge only fetches the chain for the certificate actually chosen —
   * see `certificateChain()`.
   */
  chain: Uint8Array[];
  /**
   * Where the key lives, named the way its holder names it: a token's product
   * name, a card, or a software key store. Shown in the picker, because on a
   * machine with more than one of them the CN alone does not say which.
   */
  providerName: string;
  /** The key is on removable hardware rather than in a software store. */
  hardware: boolean;
  /**
   * The certificate claims to be a qualified one on a qualified device — i.e.
   * a signature made with it is a QES. Judged from the certificate's own
   * qcStatements and policies, which is a claim rather than a verdict: the
   * verdict belongs to a validator checking the EU Trust List. False is
   * therefore reliable and true is only an expectation, which is the right way
   * round for warning someone before they sign.
   */
  qualified: boolean;
  /**
   * Key usage includes nonRepudiation (contentCommitment) — the bit that
   * separates a signing certificate from an authentication one.
   *
   * Worth surfacing because I.CA's TWINS product puts BOTH on the same card,
   * and signing a timesheet with the commercial authentication certificate
   * produces a file that verifies cryptographically and is not a QES.
   *
   * Read from the certificate and nothing else, so it says what the issuer
   * intended this certificate for — not whether this machine can act on it.
   * That is `hasKey`, and the two are separate on purpose: a certificate can
   * be a perfectly good signing certificate and still be unusable here.
   */
  forSignature: boolean;
  /**
   * The private key is present on the device.
   *
   * False means it can never sign, whatever its key usage says — and on a real
   * card that is the common case rather than the exception: an I.CA card
   * carries around thirty of its issuer's CA certificates for path building,
   * every one of them a certificate with no key. A picker that offers those is
   * offering a PIN prompt that ends in "no private key".
   */
  hasKey: boolean;
}

export interface SignDigestRequest {
  certificateId: string;
  /**
   * The bytes to be signed: the DER SignedAttributes (see ./cms.ts), NOT the
   * byte-range digest. The bridge hashes them with `hash` and produces an
   * RSASSA-PKCS1-v1_5 signature — the same contract WebCrypto's subtle.sign
   * exposes, and the one PKCS#11 reaches by building the DigestInfo itself and
   * signing with raw CKM_RSA_PKCS (the card offers no CKM_SHA256_RSA_PKCS).
   */
  data: Uint8Array;
  hash: 'SHA-256';
  /**
   * What is being signed, in words, for a bridge that shows a confirmation
   * before it signs.
   *
   * Optional because a bridge holding its own key has nobody to tell. Where
   * there IS a window, this is what makes it truthful: without it the window
   * can only describe the request, and a window that cannot name the document
   * is a window that is not really asking anything.
   */
  documentName?: string;
}

/**
 * What is stopping this bridge from signing, in the terms the export dialog
 * needs to say it — because the fix differs each time and "unavailable" tells
 * nobody which one applies.
 */
export type BridgeReadiness =
  | { state: 'ready' }
  /** Wrong browser, or a phone. Not a fault and not fixable by installing. */
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
   * Listing certificates puts something in front of the user — a pairing
   * window, a card PIN. True means the dialog has to wait to be asked rather
   * than listing the moment signing is switched on: a PIN prompt nobody
   * asked for is indistinguishable from a bug.
   */
  readonly interactive: boolean;
  /** False = do not offer this bridge; never throws. */
  isAvailable(): Promise<boolean>;
  /**
   * Why, when `isAvailable()` is false — and what the user could do about it.
   *
   * Optional so a bridge with nothing to install need not implement it; the
   * dialog falls back to saying nothing, which is right for one that is either
   * there or not.
   *
   * MUST be silent: it runs the moment signing is switched on, before the user
   * has asked for anything, so it may not pair, prompt, or unlock.
   */
  readiness?(): Promise<BridgeReadiness>;
  listCertificates(): Promise<TokenCertificate[]>;
  signDigest(request: SignDigestRequest): Promise<Uint8Array>;
  /**
   * The issuing chain of one listed certificate, if the bridge can produce it
   * and did not already fill `chain` in.
   *
   * Optional and separate from listCertificates() because fetching a chain
   * costs a round trip per certificate, and a software key store can hold
   * dozens: only the one the user actually signs with is worth the wait. Called
   * by signPdf() (./index.ts), so no caller has to remember to.
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
