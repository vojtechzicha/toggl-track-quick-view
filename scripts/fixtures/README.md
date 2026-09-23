# Signature fixtures

Test material for `pnpm check:signature` (`../check-signature.ts`).

| File | What it is |
|---|---|
| `throwaway-signer-key.pem` | An RSA-2048 private key. **Not a secret.** |
| `throwaway-signer-cert.pem` | The self-signed certificate for that key. |
| `signed-report.pdf` | A timesheet report signed with that key, the way the app signs. |

## Why the private key is committed

It signs only this fixture and chains to nothing trusted; its certificate's
common name is *Throwaway Test Signer (NOT a qualified certificate)*. Committing
it makes the fixture reproducible and the check runnable anywhere.

The real signing key stays on a hardware token and is reached through a
`TokenBridge` (`lib/export/pdf/sign/bridge.ts`). Nothing here relates to it.

The user's handwritten signature scan is gitignored and never committed. The
fixture draws a synthetic one so the image path is still tested.

## Regenerating

```sh
pnpm make:signature-fixture
```

Rewrites the certificate and the signed PDF from the committed key. Serial,
validity, signing time and content are pinned in `../signatureFixture.ts`, so
any diff in `signed-report.pdf` beyond `/CreationDate` and the trailer `/ID`
means the signing output has changed. Review it before committing.

## Validating by hand

```sh
pipx install pyhanko-cli    # the CLI is packaged separately from the library
pyhanko sign validate --pretty-print --trust throwaway-signer-cert.pem signed-report.pdf
```

`check:signature` runs the same command when `pyhanko` is on `PATH` (or set in
`$PYHANKO`) and prints a notice when it skips it.

pyHanko checks cryptography and trust, not PAdES profile conformance. For that,
use the EU DSS demo validator by hand. See `docs/pdf-signing-v2.md`.
