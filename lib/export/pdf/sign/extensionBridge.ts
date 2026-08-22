// TokenBridge over the Sign Bridge extension.
//
// The chain is page → extension → native host → PKCS#11 → card, specified in
// the sibling repository's protocol/protocol.md. This end of it does very
// little: shape a request, await a reply, and turn the reply's error code into
// something the export dialog can act on.
//
// Everything that decides whether a signature happens — the origin the browser
// vouches for, the pairing, the PIN, the confirmation window — happens on the
// far side, where the person is. That is the point of the arrangement, and the
// reason this file has no security logic in it to get wrong.

import { readCertificateInfo } from './certificateInfo';
import {
  TokenBridgeUnavailableError,
  type BridgeReadiness,
  type SignDigestRequest,
  type TokenBridge,
  type TokenCertificate,
} from './tokenBridge';

/**
 * The extension's id, pinned by the `key` in its manifest so the unpacked
 * development build and any published build are the same extension. Changing
 * it here without changing it there is a silent failure — the page simply
 * decides nothing is installed — so the sibling repo's `check-manifest.mjs`
 * derives it from the key and asserts every copy.
 */
export const SIGN_BRIDGE_EXTENSION_ID = 'jeiiaokfpmlldaebepnpppjjlhhangje';

/** Where someone is sent who has neither half installed. */
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
  /** Present on news, absent on the answer — see the sibling repo's protocol.md. */
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
   * The pairing code the helper is showing, delivered while its window is
   * still open so the two can be compared. That comparison is the only thing
   * the code is for, so a bridge built without this handler is a bridge whose
   * pairing prompt cannot be checked.
   */
  onPairingCode?: (code: string) => void;
}

export class ExtensionBridge implements TokenBridge {
  readonly id = 'sign-bridge';
  readonly label = 'Hardware token via Sign Bridge';
  // Listing pairs and unlocks; both put a window in front of the user.
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
   * The page's end of the relay, opened once and reused.
   *
   * `chrome.runtime.connect` to an extension id that is not installed returns
   * a port that disconnects immediately with `lastError` set. That is the ONLY
   * way a page can tell the extension is missing, and it is the probe
   * `readiness()` leans on.
   */
  private connect(): Port | null {
    if (this.port) return this.port;
    const chrome = runtime();
    if (!chrome) return null;

    const port = chrome.connect(SIGN_BRIDGE_EXTENSION_ID);
    port.onMessage.addListener((raw) => {
      const frame = raw as HostReply & { id?: string; code?: string };
      // News, not an answer: the request stays pending.
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
      // Everything still waiting will never be answered. Rejecting is what
      // turns "the extension vanished" into a message rather than a hang.
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
   * What is missing, in the terms the dialog needs to say it.
   *
   * Runs unprompted whenever signing is switched on, so it must be silent: no
   * pairing window, no PIN, no side effect. `hello` is specified to be exactly
   * that.
   */
  async readiness(): Promise<BridgeReadiness> {
    if (typeof window === 'undefined') {
      return { state: 'unsupported', reason: 'Signing happens in the browser.' };
    }
    if (!runtime()) {
      // Safari and Firefox have no externally_connectable, and a phone has no
      // card reader. Either way the answer is the same and it is not a fault.
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
    // Offered as soon as both halves are installed and a card is in: the
    // remaining steps — pairing, PIN — are things the user does next, not
    // reasons to hide the option.
    return (
      readiness.state === 'ready' ||
      readiness.state === 'not-paired'
    );
  }

  /** Pair if needed, then list. Both may show a window; neither is silent. */
  async listCertificates(): Promise<TokenCertificate[]> {
    const readiness = await this.readiness();
    if (readiness.state === 'not-paired') {
      const paired = await this.send({ type: 'pair' });
      if (!paired.ok || paired.paired === false) {
        throw new TokenBridgeUnavailableError(
          'Sign Bridge was not approved for this site. Approve it in the window it puts up, ' +
            'checking the code matches.'
        );
      }
    }

    const reply = await this.send({ type: 'listCertificates' });
    if (!reply.ok) throw new TokenBridgeUnavailableError(explain(reply));

    this.certificates.clear();
    return (reply.certificates ?? []).map((entry) => {
      const der = base64ToBytes(entry.der);
      this.certificates.set(entry.id, { der, tokenLabel: entry.tokenLabel });
      // Everything descriptive comes from the DER — see ./certificateInfo.ts
      // for why the helper deliberately reports none of it.
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
        // A certificate with no private key on the card cannot sign whatever
        // its key usage says — a CA certificate the card carries for path
        // building is the common case.
        forSignature: entry.hasPrivateKey && info.forSignature,
      };
    });
  }

  async signDigest(request: SignDigestRequest): Promise<Uint8Array> {
    const known = this.certificates.get(request.certificateId);
    if (!known) {
      throw new TokenBridgeUnavailableError(
        `No certificate "${request.certificateId}" is listed on this token.`
      );
    }

    // The context is what the helper's confirmation window shows, and the
    // protocol refuses a signature without one. The digest is over the bytes
    // being signed, so the window is tied to this request and not to a
    // description of it.
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
 * A failure from the helper, in a sentence rather than a CKR_ name.
 *
 * The distinction that earns its keep here is `pin_failed` against
 * `pin_locked`: a card allows a few wrong PINs and then blocks itself, needing
 * the PUK to recover. Someone told only "wrong PIN" will try until it does, so
 * the retry warning is part of the message rather than something to discover
 * afterwards.
 */
function explain(reply: HostReply): string {
  switch (reply.code) {
    case 'refused':
      return 'The signature was cancelled — the PIN prompt was dismissed.';
    case 'pin_failed':
      return (
        'That PIN was not accepted. You can try again, but a card blocks itself after a ' +
        'few wrong attempts and then needs its PUK.'
      );
    case 'pin_locked':
      return (
        'The card has blocked itself after too many wrong PINs. Unblocking it needs the ' +
        'PUK from the envelope it came in — SecureStore can do that.'
      );
    case 'no_private_key':
      return 'That certificate has no private key on the card, so it cannot sign.';
    case 'no_token':
      return 'The card is no longer in the reader.';
    case 'not_paired':
      return 'This site is no longer approved for the token — connect again.';
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
  // Chunked: a spread of a large array overflows the argument list, and the
  // SignedAttributes are small but the limit is not worth discovering later.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
