# Signature fixtures

Test material for `npm run check:signature` (see `../check-signature.ts`).

| File | What it is |
|---|---|
| `throwaway-signer-key.pem` | An RSA-2048 private key. **Not a secret.** |
| `throwaway-signer-cert.pem` | The self-signed certificate derived from it. |
| `signed-report.pdf` | A timesheet report signed with that key, as the app signs it. |

## The private key is committed on purpose

It exists to be published. It signs nothing but this fixture, it chains to
nothing anyone trusts, and its certificate says so in its own common name —
*Throwaway Test Signer (NOT a qualified certificate)*. Committing it is what
makes the fixture reproducible and the check runnable anywhere, with no key
management and nothing to leak.

The real signing key is the opposite in every respect: it lives on a certified
hardware token, never leaves it, and is reached through a `TokenBridge`
(`lib/export/pdf/sign/bridge.ts`). Nothing in this directory is ever a step
towards that key.

The user's handwritten signature scan is **not** here and never will be — it is
loaded at export time and is gitignored. The fixture draws its own synthetic
scrawl instead, so the image path is still exercised.

## Regenerating

```sh
npm run make:signature-fixture
```

Rewrites the certificate and the signed PDF from the committed key. Everything
that would otherwise vary — serial, validity, signing instant, document
contents — is pinned in `../signatureFixture.ts`, so a diff in
`signed-report.pdf` beyond its `/CreationDate` and trailer `/ID` means the
way this app signs has actually changed. That is worth reading before
committing.

## Validating by hand

```sh
pipx install pyhanko-cli    # the CLI ships separately from the pyhanko library
pyhanko sign validate --pretty-print --trust throwaway-signer-cert.pem signed-report.pdf
```

`check:signature` runs the same command when `pyhanko` is on `PATH` (or at
`$PYHANKO`) and skips it, loudly, when it is not.

pyHanko checks cryptography and trust; it explicitly does not check profile
conformance. For that — "is this really PAdES-BASELINE-B?" — use the EU DSS
demo validator, by hand at milestones. See `docs/pdf-signing-v2.md`.
