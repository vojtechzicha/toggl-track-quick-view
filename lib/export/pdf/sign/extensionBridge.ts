// TokenBridge over the Sign Bridge extension: page → extension → native host →
// PKCS#11 → card. The protocol is specified in the sibling repository's
// protocol/protocol.md.
//
// This side only sends requests and translates replies. The security checks
// (origin, pairing, PIN, confirmation window) all happen in the extension and
// the host.

import { readCertificateInfo, readCertificateNames } from './certificateInfo';
import {
  TokenBridgeUnavailableError,
  type BridgeReadiness,
  type SignDigestRequest,
  type TokenBridge,
  type TokenCertificate,
} from './tokenBridge';

/**
 * The extension's id, pinned by the `key` in its manifest so development and
 * published builds share it. If this drifts from the manifest, the page
 * reports the extension as missing. The sibling repo's `check-manifest.mjs`
 * derives the id from the key and checks every copy.
 */
export const SIGN_BRIDGE_EXTENSION_ID = 'jeiiaokfpmlldaebepnpppjjlhhangje';

/** Install link for the extension and the native host. */
const INSTALL_URL = 'https://github.com/vojtechzicha/zicha-sign-bridge/releases/latest';
const EXTENSION_URL = INSTALL_URL;

interface Port {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

interface ChromeRuntime {
  connect(extensionId: string): Port;
  lastError?: { message?: string };
}

const runtime = (): ChromeRuntime | null => {
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return chrome?.runtime?.connect ? chrome.runtime : null;
};

interface HostReply {
  ok: boolean;
  /** Set on unsolicited event frames, absent on replies. */
  event?: string;
  code?: string;
  message?: string;
  hostVersion?: string;
  paired?: boolean;
  tokens?: { label: string; serial: string }[];
  certificates?: {
    id: string;
    der: string;
    hasPrivateKey: boolean;
    tokenLabel: string;
    tokenSerial: string;
  }[];
  signature?: string;
  have?: string;
  need?: string;
}

let nextId = 0;

export interface ExtensionBridgeOptions {
  /**
   * Receives the pairing code the host is showing, while its window is open,
   * so the page can display it for the user to compare. Without this handler
   * the user has nothing to compare against.
   */
  onPairingCode?: (code: string) => void;
}

export class ExtensionBridge implements TokenBridge {
  readonly id = 'sign-bridge';
  readonly label = 'Hardware token via Sign Bridge';
  // Listing may pair and unlock, and both open a window.
  readonly interactive = true;

  private readonly options: ExtensionBridgeOptions;
  private certificates = new Map<string, { der: Uint8Array; tokenLabel: string }>();
  private port: Port | null = null;
  /** Requests still waiting for their answer, by id. */
  private pending = new Map<string, { resolve(r: HostReply): void; reject(e: Error): void }>();

  constructor(options: ExtensionBridgeOptions = {}) {
    this.options = options;
  }

  /**
   * The port to the extension, opened once and reused.
   *
   * Connecting to an extension id that is not installed returns a port that
   * disconnects immediately with `lastError` set. That is the only way a page
   * can detect a missing extension, and `readiness()` relies on it.
   */
  private connect(): Port | null {
    if (this.port) return this.port;
    const chrome = runtime();
    if (!chrome) return null;

    const port = chrome.connect(SIGN_BRIDGE_EXTENSION_ID);
    port.onMessage.addListener((raw) => {
      const frame = raw as HostReply & { id?: string; code?: string };
      // An event, not a reply: the request stays pending.
      if (frame.event === 'pairing-code') {
        if (frame.code) this.options.onPairingCode?.(frame.code);
        return;
      }
      const waiting = this.pending.get(frame.id ?? '');
      if (!waiting) return;
      this.pending.delete(frame.id ?? '');
      waiting.resolve(frame);
    });
    port.onDisconnect.addListener(() => {
      this.port = null;
      // Nothing pending will be answered now; reject so callers get an error
      // instead of hanging.
      for (const [, waiting] of this.pending) waiting.reject(new Error('no-extension'));
      this.pending.clear();
    });

    this.port = port;
    return port;
  }

  private send(message: Record<string, unknown>): Promise<HostReply> {
    const port = this.connect();
    if (!port) return Promise.reject(new Error('no-extension-api'));
    nextId += 1;
    const id = String(nextId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        port.postMessage({ id, protocol: 1, ...message });
      } catch (e) {
        this.pending.delete(id);
        reject(new Error('no-extension'));
      }
    });
  }

  /**
   * What is missing. Runs as soon as signing is switched on, so it only sends
   * `hello`, which the protocol defines as free of windows and prompts.
   */
  async readiness(): Promise<BridgeReadiness> {
    if (typeof window === 'undefined') {
      return { state: 'unsupported', reason: 'Signing happens in the browser.' };
    }
    if (!runtime()) {
      // Safari and Firefox have no externally_connectable, and a phone has no
      // card reader.
      return {
        state: 'unsupported',
        reason: 'Signing needs Chrome, Edge or another Chromium browser on a computer.',
      };
    }

    let reply: HostReply;
    try {
      reply = await this.send({ type: 'hello' });
    } catch {
      return { state: 'extension-missing', installUrl: EXTENSION_URL };
    }

    if (!reply.ok) {
      switch (reply.code) {
        case 'helper_missing':
          return { state: 'helper-missing', installUrl: INSTALL_URL };
        case 'helper_outdated':
          return {
            state: 'helper-outdated',
            have: reply.have ?? '?',
            need: reply.need ?? '?',
            installUrl: INSTALL_URL,
          };
        default:
          return { state: 'unsupported', reason: reply.message ?? 'The helper could not be reached.' };
      }
    }
    if (!reply.tokens?.length) {
      return { state: 'no-token', reason: 'No card is in the reader.' };
    }
    if (!reply.paired) return { state: 'not-paired' };
    return { state: 'ready' };
  }

  async isAvailable(): Promise<boolean> {
    const readiness = await this.readiness();
    // Offered once both halves are installed and a card is in. Pairing is the
    // user's next step, not a reason to hide the option.
    return (
      readiness.state === 'ready' ||
      readiness.state === 'not-paired'
    );
  }

  /** Pair if needed, then list. Both may open a window. */
  async listCertificates(): Promise<TokenCertificate[]> {
    const readiness = await this.readiness();
    if (readiness.state === 'not-paired') {
      const paired = await this.send({ type: 'pair' });
      if (!paired.ok || paired.paired === false) {
        throw new TokenBridgeUnavailableError(
          'Sign Bridge was not approved for this site. Approve it in the Sign Bridge window ' +
            'after checking that the code matches.'
        );
      }
    }

    const reply = await this.send({ type: 'listCertificates' });
    if (!reply.ok) throw new TokenBridgeUnavailableError(explain(reply));

    this.certificates.clear();
    return (reply.certificates ?? []).map((entry) => {
      const der = base64ToBytes(entry.der);
      this.certificates.set(entry.id, { der, tokenLabel: entry.tokenLabel });
      // The host sends only DER; ./certificateInfo.ts reads everything else.
      const info = readCertificateInfo(der);
      return {
        id: entry.id,
        subjectCN: info.subjectCN,
        issuerCN: info.issuerCN,
        notBeforeMs: info.notBeforeMs,
        notAfterMs: info.notAfterMs,
        der,
        chain: [],
        providerName: entry.tokenLabel,
        hardware: true,
        qualified: info.qualified,
        forSignature: info.forSignature,
        hasKey: entry.hasPrivateKey,
      };
    });
  }

  /**
   * The issuing chain of one listed certificate, built from the other
   * certificates on the card.
   *
   * The card carries its issuer's CA certificates, so the chain needs no extra
   * request: walk up the listed certificates, matching each issuer name to
   * another's subject. Embedding the chain lets a validator build the path
   * without fetching the issuer over AIA, which offline validators will not do.
   *
   * Returns the chain without the leaf, as far as the card's certificates
   * reach. A self-issued certificate (the root) ends the walk.
   */
  async certificateChain(certificateId: string): Promise<Uint8Array[]> {
    const leaf = this.certificates.get(certificateId);
    if (!leaf) return [];

    // Rebuilt per call so a swapped card cannot leave a stale index.
    const bySubject = new Map<string, { der: Uint8Array; names: { subject: string; issuer: string } }>();
    for (const [id, entry] of this.certificates) {
      if (id === certificateId) continue;
      const names = readCertificateNames(entry.der);
      // First one wins when two certificates share a subject (a re-issued CA).
      if (names && !bySubject.has(names.subject)) bySubject.set(names.subject, { der: entry.der, names });
    }

    const chain: Uint8Array[] = [];
    let names = readCertificateNames(leaf.der);
    // Bounded in case the card holds a certificate cycle.
    while (names && chain.length < 8) {
      if (names.issuer === names.subject) break;
      const issuer = bySubject.get(names.issuer);
      if (!issuer) break;
      chain.push(issuer.der);
      bySubject.delete(names.issuer);
      names = issuer.names;
    }
    return chain;
  }

  async signDigest(request: SignDigestRequest): Promise<Uint8Array> {
    const known = this.certificates.get(request.certificateId);
    if (!known) {
      throw new TokenBridgeUnavailableError(
        `No certificate "${request.certificateId}" is listed on this token.`
      );
    }

    // The host's confirmation window shows `context`, and the protocol requires
    // it. The digest is over the bytes being signed, which ties the window to
    // this exact request.
    const digest = await sha256Hex(request.data);
    const reply = await this.send({
      type: 'sign',
      certificateId: request.certificateId,
      hash: request.hash,
      data: bytesToBase64(request.data),
      context: {
        documentName: request.documentName ?? `a document on ${known.tokenLabel}`,
        digest,
      },
    });

    if (!reply.ok || !reply.signature) throw new TokenBridgeUnavailableError(explain(reply));
    return base64ToBytes(reply.signature);
  }
}

/**
 * A host failure as a sentence. `pin_failed` warns about the retry limit
 * because a card blocks itself after a few wrong PINs and then needs its PUK.
 */
function explain(reply: HostReply): string {
  switch (reply.code) {
    case 'refused':
      return 'Signing was cancelled: the PIN prompt was closed.';
    case 'pin_failed':
      return (
        'That PIN was not accepted. You can try again, but the card blocks itself after a ' +
        'few wrong attempts and then needs its PUK.'
      );
    case 'pin_locked':
      return (
        'The card is blocked after too many wrong PINs. Unblock it in SecureStore with the ' +
        'PUK from the card’s envelope.'
      );
    case 'no_private_key':
      return 'That certificate has no private key on the card, so it cannot sign.';
    case 'no_token':
      return 'The card is no longer in the reader.';
    case 'not_paired':
      return 'This site is no longer approved in Sign Bridge. Connect again.';
    default:
      return reply.message ?? 'The token did not sign.';
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked because spreading a large array overflows the argument list.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
