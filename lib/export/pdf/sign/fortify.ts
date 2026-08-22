// TokenBridge over Fortify — the hardware path (phase 3 of docs/pdf-signing-v2.md).
//
// Fortify is a desktop app that loads PKCS#11 modules and republishes them to
// web pages as WebCrypto providers over a local TLS socket. That is the whole
// reason it exists here: the qualified key is on an I.CA card, browsers have no
// way to reach a card, and Fortify is the piece that bridges the two without a
// browser plugin.
//
// The client library does the protocol; this module does the mapping. What is
// actually ours:
//
//  - deciding when to pair (Fortify shows a code, the page must show the same
//    one) and surfacing that code rather than leaving the user staring at an
//    unexplained window;
//  - flattening providers × certificates into one list the picker can show,
//    keeping enough about each to warn before the wrong one is used;
//  - fetching a chain only for the certificate that gets signed with.

import {
  TokenBridgeUnavailableError,
  type SignDigestRequest,
  type TokenBridge,
  type TokenCertificate,
} from './tokenBridge';

/**
 * Where Fortify listens, and the endpoint it answers unauthenticated.
 *
 * Repeated from the client library rather than read off a `FortifyAPI`
 * instance, and that is the point: `isAvailable()` is called on every bridge
 * the moment the export dialog offers signing, and constructing a FortifyAPI
 * means downloading the client, protobuf.js and the socket implementation —
 * a megabyte or so to discover that Fortify is not installed. A one-line fetch
 * answers the same question for nothing. The constant is checked against the
 * library's own by scripts/check-signature.ts.
 */
export const FORTIFY_ORIGIN = 'https://127.0.0.1:31337';
const FORTIFY_PROBE = `${FORTIFY_ORIGIN}/.well-known/webcrypto-socket`;

export interface FortifyBridgeOptions {
  /**
   * Called with Fortify's pairing code, and only when approval is actually
   * needed — i.e. the first time this origin asks this Fortify installation for
   * a token, and again after the user revokes it.
   *
   * The page has to display it: Fortify's own window shows the same four
   * characters, and matching them is what tells the user the window belongs to
   * the page in front of them rather than to something else. `login()` is
   * already waiting when this fires.
   */
  onPairing?: (code: string) => void;
  /** Fortify's socket closed — the app quit, or the pairing was revoked. */
  onDisconnect?: () => void;
}

/** What a listed certificate needs for the calls that come after listing. */
interface ListedCertificate {
  providerId: string;
  /** The certificate object the client hands back; getChain() wants it whole. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any;
  index: string;
}

/**
 * Minimal shape of the pieces of `@peculiar/fortify-client-core` used here.
 *
 * Declared locally rather than imported as types because the import has to stay
 * dynamic — see `connect()` — and pulling the package's types in statically
 * would have `tsc` resolve, and the bundler follow, a module this file is
 * careful never to load eagerly.
 */
interface FortifyProvider {
  id: string;
  name: string;
  isHardware: boolean;
  isRemovable: boolean;
  atr: string;
  card: string;
}

const notConnected = (): never => {
  throw new TokenBridgeUnavailableError(
    'Fortify is not connected. Choose a certificate before signing.'
  );
};

/**
 * How the client library's own errors read to someone who has to fix them.
 * `start()` throws bare strings as Error messages; unmapped ones are passed
 * through rather than swallowed.
 */
const EXPLAIN: Record<string, string> = {
  connection_not_supported:
    'This browser cannot reach Fortify — a phone browser has no way to talk to a card reader.',
  connection_not_detected:
    'Fortify is not running. Start the Fortify app (its icon sits in the menu bar) and try again.',
  connection_key_not_approved:
    'Fortify did not approve this page. Approve the pairing in the Fortify window, then try again.',
};

const explain = (error: unknown): Error => {
  const message = error instanceof Error ? error.message : String(error);
  return new TokenBridgeUnavailableError(EXPLAIN[message] ?? message);
};

export class FortifyBridge implements TokenBridge {
  readonly id = 'fortify';
  readonly label = 'Hardware token via Fortify';
  // Listing pairs with Fortify and logs in to each token: both show a window.
  readonly interactive = true;

  private readonly options: FortifyBridgeOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private api: any = null;
  private readonly listed = new Map<string, ListedCertificate>();

  constructor(options: FortifyBridgeOptions = {}) {
    this.options = options;
  }

  /**
   * Whether Fortify is running and reachable. Never throws, and never pairs:
   * this runs before the user has asked for anything, so it must not put a
   * window in front of them.
   */
  async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    try {
      const response = await fetch(FORTIFY_PROBE, { cache: 'no-store' });
      return response.ok;
    } catch {
      // Fortify absent, stopped, or its local TLS certificate not trusted by
      // this browser — all of which mean the same thing here.
      return false;
    }
  }

  /** Connect, and pair if this origin has not been approved yet. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async connect(): Promise<any> {
    if (this.api) return this.api;

    // Dynamic: the client drags protobuf.js and the socket implementation with
    // it, and an export that is never signed must not pay for them.
    const { FortifyAPI } = await import('@peculiar/fortify-client-core');
    const api = new FortifyAPI({
      onDebug: () => {},
      onClose: () => {
        this.api = null;
        this.listed.clear();
        this.options.onDisconnect?.();
      },
      onProvidersAdded: () => {},
      onProvidersRemoved: () => {},
      filters: {
        // Only certificates that can actually sign: one with no private key on
        // this machine is a contact's certificate, not an identity. This is
        // also what makes the client log in to each provider while listing,
        // which is why listing is a deliberate act in the UI and not something
        // that happens the moment signing is switched on — a PIN prompt nobody
        // asked for is indistinguishable from a bug.
        onlyWithPrivateKey: true,
      },
    });

    try {
      await api.start();
      const challenge = await api.challenge();
      if (challenge) {
        this.options.onPairing?.(challenge);
        await api.login();
      }
    } catch (error) {
      api.finish();
      throw explain(error);
    }

    this.api = api;
    return api;
  }

  async listCertificates(): Promise<TokenCertificate[]> {
    const api = await this.connect();
    // X509Schema comes from the same chunk the client is already in, so reading
    // the qualified claim off each certificate costs nothing extra here.
    const { X509Schema } = await import('@peculiar/fortify-client-core');

    let providers: FortifyProvider[];
    try {
      providers = (await api.getProviders()) as FortifyProvider[];
    } catch (error) {
      throw explain(error);
    }

    this.listed.clear();
    const result: TokenCertificate[] = [];

    for (const provider of providers) {
      // Per provider rather than getCertificatesByProviders(): the association
      // between a certificate and the token it came off is what the picker
      // shows, and the flat call throws it away. A provider that refuses to
      // open — a card left in a reader with a blocked PIN, say — must not take
      // the rest of the list down with it.
      let certificates: unknown[];
      try {
        certificates = await api.getCertificatesByProviderId(provider.id);
      } catch {
        continue;
      }

      for (const item of certificates as {
        index: string;
        raw: ArrayBuffer;
        subjectName: string;
        issuerName: string;
        notBefore: Date;
        notAfter: Date;
      }[]) {
        const id = `${provider.id}:${item.index}`;
        this.listed.set(id, { providerId: provider.id, item, index: item.index });

        let qualified = false;
        let forSignature = false;
        try {
          const schema = new X509Schema(item.raw);
          qualified = schema.isQualified();
          forSignature = schema.hasKeyUsage(['nonRepudiation']);
        } catch {
          // A certificate whose extensions will not parse is still signable;
          // it just cannot be vouched for, and false is the honest answer.
        }

        result.push({
          id,
          subjectCN: commonName(item.subjectName),
          issuerCN: commonName(item.issuerName),
          notBeforeMs: item.notBefore.getTime(),
          notAfterMs: item.notAfter.getTime(),
          der: new Uint8Array(item.raw),
          // Fetched later, for the one that gets used — see certificateChain().
          chain: [],
          providerName: provider.name,
          hardware: provider.isHardware || provider.isRemovable,
          qualified,
          forSignature,
        });
      }
    }

    return result;
  }

  async certificateChain(certificateId: string): Promise<Uint8Array[]> {
    const listed = this.listed.get(certificateId);
    if (!listed) return [];
    const api = this.api ?? notConnected();

    try {
      const provider = await api.getProviderById(listed.providerId, false);
      const items = (await provider.certStorage.getChain(listed.item)) as {
        type: string;
        value: ArrayBuffer;
      }[];
      const leaf = new Uint8Array(listed.item.raw);
      return items
        .filter((entry) => entry.type === 'x509')
        .map((entry) => new Uint8Array(entry.value))
        // getChain() returns the path from the leaf up; ./cms.ts ships the
        // signer separately, so repeating it here would put it in twice.
        .filter((der) => !sameBytes(der, leaf));
    } catch {
      // A missing chain costs a validator an extra AIA fetch. It is not worth
      // failing a signature over.
      return [];
    }
  }

  async signDigest(request: SignDigestRequest): Promise<Uint8Array> {
    const listed = this.listed.get(request.certificateId);
    if (!listed) {
      throw new TokenBridgeUnavailableError(
        `No certificate "${request.certificateId}" is listed on this Fortify connection.`
      );
    }
    const api = this.api ?? notConnected();

    try {
      // needLogin: the PIN prompt belongs here, at the moment of signing, even
      // when listing already asked for it — the card may have been pulled, and
      // an expired session must re-ask rather than fail.
      const provider = await api.getProviderById(listed.providerId, true);
      const privateKey = await provider.certStorage.findPrivateKey(listed.item);
      if (!privateKey) {
        throw new TokenBridgeUnavailableError(
          'That certificate has no private key on this device, so it cannot sign.'
        );
      }
      const signature = await provider.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5', hash: request.hash },
        privateKey,
        request.data as unknown as BufferSource
      );
      return new Uint8Array(signature);
    } catch (error) {
      throw explain(error);
    }
  }

  /** Drop the socket. Safe to call when nothing is open. */
  disconnect(): void {
    this.api?.finish();
    this.api = null;
    this.listed.clear();
  }
}

/**
 * The CN out of an RFC 4514 distinguished name, falling back to the whole name.
 *
 * The client already parses the DN into `subject`/`issuer` maps, but only for
 * certificates it returns from its own filtered path; taking the CN off the
 * string keeps this module working off one field either way.
 *
 * The escapes are the reason this is not a `split(',')`. A Czech certificate
 * subject is routinely `CN=Zicha\\, Vojtěch, O=…` — the comma inside the name is
 * escaped, and splitting on commas cuts the name in half. Exported for
 * scripts/check-signature.ts, which is where those cases are pinned down.
 */
export function commonName(distinguishedName: string): string {
  // A comma only separates RDNs when it is not itself escaped.
  const match = /(?:^|(?<!\\),)\s*CN=((?:[^,\\]|\\.)*)/i.exec(distinguishedName ?? '');
  if (!match) return distinguishedName ?? '';
  return match[1].replace(/\\(.)/g, '$1').trim();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
