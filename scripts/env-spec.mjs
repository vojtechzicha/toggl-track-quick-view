// The deployment configuration this app reads, in ONE place.
//
// Why plain .mjs and not a .ts file under lib/: `pnpm env:check` runs inside
// the Vercel build BEFORE next build compiles anything, so the spec has to be
// importable by bare Node with no loader and no type stripping.
//
// Adding a variable means: add it here, add it to .env.tpl and .env.prod.tpl,
// then put the value in 1Password and in Vercel. See docs/ENVIRONMENT.md.
//
// The cross-variable rules at the bottom are the interesting part. This app has
// no required variables in the usual sense — with an empty environment it runs
// happily as a bring-your-own-token dashboard. What it has instead is a handful
// of COMBINATIONS that silently change what the deployment is (Toggl mode vs.
// standalone) or silently disable a feature you thought you had turned on.
// Those are what this file exists to catch.

/**
 * @typedef {'dev' | 'prod' | 'preview'} EnvEnvironment
 *
 * @typedef {Object} EnvVarSpec
 * @property {string} name
 * @property {'server' | 'public'} scope     `public` is inlined into the browser bundle at build time.
 * @property {boolean} [required]            Required in every environment it applies to.
 *   (Environment-specific requirements live in DEPLOYMENT_TOPOLOGY below.)
 * @property {EnvEnvironment[]} [appliesTo]  Defaults to ALL of dev, prod and preview.
 * @property {string} description
 * @property {(value: string) => string | null} [check] Returns a problem, or null when fine.
 */

const mustBeMongoUri = (value) =>
  /^mongodb(\+srv)?:\/\/[^/\s]+/.test(value)
    ? null
    : 'must look like mongodb://host:port/db or mongodb+srv://user:password@cluster/db';

// https://www.mongodb.com/docs/manual/reference/limits/#naming-restrictions
const mustBeDbName = (value) => {
  if (/[/\\. "$*<>:|?]/.test(value)) return 'must not contain any of / \\ . " $ * < > : | ? or a space';
  return Buffer.byteLength(value) <= 63 ? null : 'must be at most 63 bytes';
};

// Git remote for the PDF template pack (scripts/sync-pack.mjs). Only two forms
// can work: https, which a token can authenticate, and ssh, which cannot be
// authenticated inside a Vercel build at all.
const mustBeGitRemote = (value) => {
  if (/\s/.test(value)) return 'must not contain whitespace';
  if (/^https:\/\/\S+\/\S+/.test(value)) return null;
  if (/^(ssh:\/\/)?[^@\s]+@[^:\s]+[:/]\S+/.test(value)) return null;
  return 'must be a git remote — https://host/owner/repo.git, or git@host:owner/repo.git';
};

const isSshRemote = (value) => !value.startsWith('https://');

// An RFC 3161 timestamp authority. http is normal and not a mistake: the
// protocol signs its own answers, so the transport adds nothing a validator
// relies on, and several public TSAs are http-only.
const mustBeTsaUrl = (value) => {
  if (/\s/.test(value)) return 'must not contain whitespace';
  return /^https?:\/\/\S+/.test(value) ? null : 'must be an http(s) URL to an RFC 3161 endpoint';
};

/** Mirrors cacheIntervalSec() in lib/serverCache.ts. */
const BOOLISH = /^(1|true|on|yes)$/i;

const mustBeCacheInterval = (value) => {
  if (BOOLISH.test(value)) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || String(n) !== value.trim()) {
    return 'must be a whole number of seconds, or one of 1/true/on/yes to use the 180s default';
  }
  return n > 0 ? null : 'must be greater than 0 (a non-positive value silently disables the cache instead)';
};

/**
 * Which variables THIS repository's own deployments must have, per environment.
 *
 * Nothing here is a requirement of the APPLICATION. Every variable below is
 * optional to the code, and an empty environment is a supported mode: the app
 * then runs as a bring-your-own-token dashboard, which is what README.md
 * documents for a one-click Vercel deploy. These entries describe the shape
 * track.zicha.dev and its previews actually run — Toggl as the source, MongoDB
 * behind it for settings sync, the whole thing behind a password — so that
 * shape cannot change by accident. Losing APP_MODE would convert the live
 * dashboard to an empty standalone store and still deploy green.
 *
 * A FORK running its own instance almost certainly has a different shape.
 * Empty this object and every requirement relaxes to optional; the format
 * checks and the cross-variable rules below still apply, because those follow
 * from the code rather than from anyone's topology.
 */
export const DEPLOYMENT_TOPOLOGY = {
  // Both deployments carry MONGODB_URI, so both need the override that keeps
  // Toggl as the source rather than flipping to standalone.
  APP_MODE: ['prod', 'preview'],
  TOGGL_API_TOKEN: ['prod', 'preview'],
  APP_PASSWORD: ['prod', 'preview'],
  MONGODB_URI: ['prod', 'preview'],
  // Preview shares production's connection string, so the database name is the
  // only thing keeping a branch out of the live synced setup.
  MONGODB_DB: ['preview'],
  // The documents this deployment actually produces come from the private
  // template pack. Without it the export dialog still works — it just offers
  // the app's own generic Timesheet and nothing that has ever been filed with
  // a client, which is the kind of loss that deploys green.
  PDF_TEMPLATE_PACK_REPO: ['prod', 'preview'],
  PDF_TEMPLATE_PACK_TOKEN: ['prod', 'preview'],
}

/** @type {EnvVarSpec[]} */
export const ENV_SPEC = [
  // -- Track source -----------------------------------------------------------
  {
    name: 'APP_MODE',
    scope: 'server',
    description:
      'The literal "toggl" keeps Toggl as the track source even when MONGODB_URI is set, so the database serves settings sync only. Without it, MONGODB_URI flips the whole app to standalone mode — a different product against a different data store.',
    check: (value) =>
      value === 'toggl'
        ? null
        : 'must be exactly "toggl" (or left empty). No other value means anything, and a typo silently reverts the deployment to standalone mode',
  },

  // -- Toggl ------------------------------------------------------------------
  {
    name: 'TOGGL_API_TOKEN',
    scope: 'server',
    description:
      'Toggl Track API token from https://track.toggl.com/profile. Setting it makes the deployment server-managed: the browser never holds a token and the token field disappears from Settings. Ignored in standalone mode.',
    check: (value) => {
      if (/\s/.test(value)) return 'must not contain whitespace (a stray newline from a copy-paste is the usual cause)';
      return value.length >= 20 && value.length <= 64 ? null : 'does not look like a Toggl API token (expected ~32 characters)';
    },
  },
  {
    name: 'TOGGL_CACHE_INTERVAL',
    scope: 'server',
    description:
      'Seconds between upstream Toggl refreshes for the SHARED server-side cache, or 1/true/on/yes for the 180s default. Requires TOGGL_API_TOKEN and Toggl mode. While set, the per-device "Refresh interval" picker is hidden and this cadence is used instead.',
    check: mustBeCacheInterval,
  },

  // -- Database ---------------------------------------------------------------
  {
    name: 'MONGODB_URI',
    scope: 'server',
    description:
      'MongoDB connection string. On its own it switches the app to standalone mode; together with APP_MODE=toggl it backs cross-device settings sync instead. Either way it needs APP_PASSWORD, because both write.',
    check: mustBeMongoUri,
  },
  {
    name: 'MONGODB_DB',
    scope: 'server',
    description:
      'Database name inside the cluster. Defaults to "toggl-quick-view" in lib/store/mongo.ts. Note the code ALWAYS passes an explicit name, so any database in the connection string path is ignored — this variable is the only thing that changes it. Required on PREVIEW because preview shares production\'s connection string: the database name is the only thing keeping a branch deployment out of the live synced setup.',
    check: mustBeDbName,
  },

  // -- Access -----------------------------------------------------------------
  {
    name: 'APP_PASSWORD',
    scope: 'server',
    description:
      'Password gate for the whole dashboard. Required whenever MONGODB_URI is set (those routes write), and strongly wanted whenever TOGGL_API_TOKEN is, since otherwise anyone with the URL reads your time entries.',
    check: (value) =>
      value.length >= 8
        ? null
        : 'should be at least 8 characters — it is the only thing between the public internet and your time entries',
  },

  // -- PDF template pack (build time only) ------------------------------------
  {
    name: 'PDF_TEMPLATE_PACK_REPO',
    scope: 'server',
    description:
      'Git remote of an optional PDF template pack, checked out into pdf-templates/ before the build by scripts/sync-pack.mjs. Left empty, the app offers only the templates it ships. Read at BUILD time, never at runtime — changing it needs a redeploy. Use the https form in a deployment (a Vercel build has no ssh key); ssh is for a laptop.',
    check: mustBeGitRemote,
  },
  {
    name: 'PDF_TEMPLATE_PACK_REF',
    scope: 'server',
    description:
      'Branch, tag or commit of the template pack to build against. Defaults to "main". Pin it to a commit when a pack change should not be able to alter the next deployment of this app on its own.',
    check: (value) =>
      /\s/.test(value) ? 'must not contain whitespace' : null,
  },
  {
    name: 'PDF_TEMPLATE_PACK_TOKEN',
    scope: 'server',
    description:
      'Token that can read PDF_TEMPLATE_PACK_REPO over https — a GitHub fine-grained PAT with Contents: Read on that one repository is enough. Only needed for a PRIVATE pack, and only where the checkout has no other credentials (i.e. every deployment).',
    check: (value) =>
      /\s/.test(value) ? 'must not contain whitespace (a stray newline from a copy-paste is the usual cause)' : null,
  },

  // -- Signing ----------------------------------------------------------------
  {
    name: 'TSA_URL',
    scope: 'server',
    description:
      'RFC 3161 timestamp authority, proxied by /api/timestamp. Set it and a signed PDF export becomes PAdES-B-T instead of B-B, which is what keeps the signature verifying after the signing certificate expires. Blank disables timestamping entirely — no third party is contacted and signing still works, one level lower. Only a TSA on the EU Trust List gives a clean DSS report; see docs/pdf-signing-v2.md.',
    check: mustBeTsaUrl,
  },
  {
    name: 'TSA_CREDENTIALS',
    scope: 'server',
    description:
      'HTTP Basic credentials for a commercial timestamp authority, as user:password. Free authorities need none. Ignored without TSA_URL.',
    check: (value) =>
      value.includes(':') ? null : 'must be user:password',
  },
];

/**
 * Supplied by the platform, by a one-off command, or by machine-level tooling —
 * never written to .env, so the templates must NOT list them.
 */
export const EXTERNAL_ENV = {
  platform: ['NODE_ENV', 'PORT', 'CI', 'VERCEL', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA'],
  // Computed by next.config.js at build time (from the git commit) and baked
  // into the bundle for the post-deploy refresh hint — nobody ever sets it.
  derived: ['NEXT_PUBLIC_BUILD_ID'],
  // scripts/check-windows.ts reassigns TZ per case to exercise DST boundaries.
  scriptFlags: ['TZ'],
  // A 1Password service-account token in a generated .env would sit on every
  // dev machine — it belongs in the shell profile (docs/ENVIRONMENT.md).
  tooling: ['OP_SERVICE_ACCOUNT_TOKEN', 'VERCEL_OIDC_TOKEN'],
};

const DEFAULT_APPLIES_TO = ['dev', 'prod', 'preview'];

const appliesTo = (spec, environment) => (spec.appliesTo ?? DEFAULT_APPLIES_TO).includes(environment);

const isRequired = (spec, environment) =>
  spec.required === true || (DEPLOYMENT_TOPOLOGY[spec.name] ?? []).includes(environment);

/** Variable names that belong in the template for the given environment. */
export function envVarNames(environment) {
  return ENV_SPEC.filter((spec) => appliesTo(spec, environment)).map((s) => s.name);
}

/** The single definition of "is this variable set" — check-env.mjs uses it too. */
export const present = (env, name) => (env[name] ?? '').trim();

/** What `vercel env pull` writes instead of a value it is not allowed to read. */
const PULLED_PLACEHOLDER = '[SENSITIVE]';

/** The placeholder .env.prod.tpl carries for a secret nobody has recovered yet. */
const UNSET_PLACEHOLDER = 'replaceMe';

/**
 * @param {Record<string, string | undefined>} env
 * @param {EnvEnvironment} [environment] Which environment this snapshot belongs
 *   to. Defaults to 'dev' — the local `pnpm env:check` case.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateEnv(env, environment = 'dev') {
  const errors = [];
  const warnings = [];

  for (const spec of ENV_SPEC) {
    if (!appliesTo(spec, environment)) continue;
    const value = present(env, spec.name);
    if (!value) {
      if (isRequired(spec, environment)) errors.push(`${spec.name} is required. ${spec.description}`);
      continue;
    }
    // `vercel env pull` writes this placeholder for variables marked
    // "Sensitive" — their real values can never be read back out of Vercel.
    // Copied into 1Password unnoticed, it produces an .env that looks fully
    // configured and fails at the provider instead.
    if (value === PULLED_PLACEHOLDER) {
      errors.push(
        `${spec.name} is the literal "${PULLED_PLACEHOLDER}" placeholder from \`vercel env pull\`, not a real value. Take it from the service that issued it.`
      );
      continue;
    }
    if (value === UNSET_PLACEHOLDER) {
      errors.push(
        `${spec.name} is still the "${UNSET_PLACEHOLDER}" placeholder — the 1Password field exists but nobody has put the real value in it yet.`
      );
      continue;
    }
    // A hand-copied template (`cp .env.tpl .env`, the documented no-1Password
    // path) leaves 1Password references as values. APP_PASSWORD is the one that
    // matters: an op:// string is committed, public, and long enough to pass
    // the length check, which would make the gate open to anyone reading git.
    if (value.startsWith('op://')) {
      errors.push(
        `${spec.name} is an unresolved 1Password reference. Run \`pnpm env:pull\` (op inject), or replace the reference with the real value.`
      );
      continue;
    }
    // The value itself is never echoed: half of these are secrets, and the name
    // plus the rule is enough to fix the problem.
    const problem = spec.check?.(value);
    if (problem) errors.push(`${spec.name} ${problem}.`);
  }

  // -- Cross-variable rules ---------------------------------------------------
  // These mirror lib/store/mongo.ts, lib/sync/server.ts, lib/serverAuth.ts and
  // lib/serverCache.ts. Change one of those and change the matching rule here.

  const uri = present(env, 'MONGODB_URI');
  const password = present(env, 'APP_PASSWORD');
  const token = present(env, 'TOGGL_API_TOKEN');
  const mode = present(env, 'APP_MODE');
  const interval = present(env, 'TOGGL_CACHE_INTERVAL');
  const dbName = present(env, 'MONGODB_DB');
  const standalone = Boolean(uri) && mode !== 'toggl';

  // The app itself reports this one to the browser as `misconfigured` and then
  // refuses to serve the store routes, so it is a deployment that boots and
  // does nothing. Catch it at build time instead.
  if (uri && !password) {
    errors.push(
      standalone
        ? 'MONGODB_URI is set without APP_PASSWORD, so the app is in standalone mode and every store route refuses to answer. Set APP_PASSWORD, or unset MONGODB_URI.'
        : 'MONGODB_URI is set without APP_PASSWORD, so settings sync stays off — /api/sync accepts writes and will not do so unauthenticated. Set APP_PASSWORD, or unset MONGODB_URI.'
    );
  }

  // A password nobody is ever asked for. gateEnabled() needs something worth
  // gating, and with neither a server token nor a database there is nothing:
  // each browser holds its own Toggl token in localStorage.
  if (password && !token && !uri) {
    warnings.push(
      'APP_PASSWORD has no effect: with neither TOGGL_API_TOKEN nor MONGODB_URI set, each browser holds its own Toggl token and there is nothing server-side to gate.'
    );
  }

  // The inverse, and the dangerous one: real time entries served to anyone who
  // learns the URL. An error would be wrong (a genuinely public dashboard is a
  // legitimate choice) but it should never pass unremarked.
  //
  // Deployed environments only. A local dev server has no URL anyone else can
  // reach, so the same state is the DEFAULT there — .env.tpl ships APP_PASSWORD
  // blank precisely to save you a password prompt on every `pnpm dev`.
  if (token && !password && environment !== 'dev') {
    warnings.push(
      'TOGGL_API_TOKEN is set without APP_PASSWORD: the server holds the token, so this deployment shows your time entries to anyone who knows its URL.'
    );
  }

  // APP_MODE only ever overrides what MONGODB_URI would otherwise do.
  if (mode === 'toggl' && !uri) {
    warnings.push(
      'APP_MODE=toggl has nothing to override — it only matters alongside MONGODB_URI, which is not set here. Harmless, but it suggests a MONGODB_URI was meant to be set too.'
    );
  }

  // Same shape: names a database that nothing will open.
  if (dbName && !uri) {
    warnings.push(
      `MONGODB_DB is "${dbName}" but MONGODB_URI is not set, so no database is opened and the name is inert.`
    );
  }

  // cacheIntervalSec() is consulted only for the server-held token in Toggl
  // mode, so these two states look configured and do nothing.
  if (interval && !token) {
    warnings.push(
      'TOGGL_CACHE_INTERVAL is set but TOGGL_API_TOKEN is not: the shared cache only ever serves the server-held token, so it stays off and each browser refreshes on its own cadence.'
    );
  } else if (interval && standalone) {
    warnings.push(
      'TOGGL_CACHE_INTERVAL is set but the app is in standalone mode, where there is no upstream rate limit to work around. The cache stays off. Add APP_MODE=toggl if Toggl was meant to remain the source.'
    );
  }

  // Toggl's Free plan allows 30 requests/hour, which is one per 120s. The app
  // clamps to a 30s floor without complaint, so a value below the budget looks
  // accepted right up until upstream starts answering 429.
  if (interval && !BOOLISH.test(interval)) {
    const seconds = Number.parseInt(interval, 10);
    if (Number.isFinite(seconds) && seconds > 0 && seconds < 120) {
      warnings.push(
        `TOGGL_CACHE_INTERVAL is ${seconds}s, which is ${Math.round(3600 / seconds)} upstream requests/hour — over Toggl's Free-plan budget of 30. Use 120 or more.`
      );
    }
  }

  // -- PDF template pack --
  // Mirrors scripts/sync-pack.mjs, which is the thing that acts on these.

  const packRepo = present(env, 'PDF_TEMPLATE_PACK_REPO');
  const packRef = present(env, 'PDF_TEMPLATE_PACK_REF');
  const packToken = present(env, 'PDF_TEMPLATE_PACK_TOKEN');

  if (packRepo && environment !== 'dev' && isSshRemote(packRepo)) {
    // Not a preference: a Vercel build has no ssh key and no agent, so the
    // fetch cannot succeed. sync-pack.mjs would fail the build a minute later.
    errors.push(
      'PDF_TEMPLATE_PACK_REPO is an ssh remote, which no deployment can fetch — there is no ssh key in a build. Use the https form and set PDF_TEMPLATE_PACK_TOKEN.'
    );
  } else if (packRepo && !packToken && !isSshRemote(packRepo)) {
    warnings.push(
      'PDF_TEMPLATE_PACK_REPO is an https remote with no PDF_TEMPLATE_PACK_TOKEN. Fine for a public pack; a private one fails the checkout, and with it the build.'
    );
  }

  if (packToken && !packRepo) {
    warnings.push(
      'PDF_TEMPLATE_PACK_TOKEN is set but PDF_TEMPLATE_PACK_REPO is not, so nothing is checked out and the token is inert.'
    );
  }

  if (packRef && !packRepo) {
    warnings.push(
      `PDF_TEMPLATE_PACK_REF is "${packRef}" but PDF_TEMPLATE_PACK_REPO is not set, so there is no pack for it to pin.`
    );
  }

  // TOGGL_API_TOKEN is read only by the Toggl proxy, which standalone mode
  // never reaches.
  if (token && standalone) {
    warnings.push(
      'TOGGL_API_TOKEN is ignored: MONGODB_URI without APP_MODE=toggl puts the app in standalone mode, which serves its own store rather than Toggl.'
    );
  }

  return { errors, warnings };
}
