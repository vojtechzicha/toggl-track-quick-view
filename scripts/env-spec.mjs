// Every environment variable the app reads, with format checks and the rules
// for combinations. See docs/ENVIRONMENT.md.
//
// Plain .mjs because `pnpm env:check` runs in the Vercel build before anything
// is compiled, so bare Node must be able to import it.
//
// The app needs no variable to start (an empty environment is a
// bring-your-own-token dashboard). What goes wrong is combinations that change
// what the deployment is (Toggl vs. standalone) or leave a feature off; the
// rules in validateEnv() catch those.

/**
 * @typedef {'dev' | 'prod' | 'preview'} EnvEnvironment
 *
 * @typedef {Object} EnvVarSpec
 * @property {string} name
 * @property {'server' | 'public'} scope     `public` is inlined into the browser bundle at build time.
 * @property {boolean} [required]            Required in every environment it applies to.
 *   Per-environment requirements go in DEPLOYMENT_TOPOLOGY.
 * @property {EnvEnvironment[]} [appliesTo]  Defaults to dev, prod and preview.
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

// https (a token can authenticate it) or ssh (works locally only).
const mustBeGitRemote = (value) => {
  if (/\s/.test(value)) return 'must not contain whitespace';
  if (/^https:\/\/\S+\/\S+/.test(value)) return null;
  if (/^(ssh:\/\/)?[^@\s]+@[^:\s]+[:/]\S+/.test(value)) return null;
  return 'must be a git remote: https://host/owner/repo.git or git@host:owner/repo.git';
};

const isSshRemote = (value) => !value.startsWith('https://');

// http is fine: RFC 3161 responses are signed, and several public TSAs are
// http-only.
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
    return 'must be a whole number of seconds, or 1/true/on/yes for the 180s default';
  }
  return n > 0 ? null : 'must be greater than 0 (0 or less turns the cache off)';
};

/**
 * What track.zicha.dev and its previews must have, per environment: Toggl as
 * the source, MongoDB for settings sync, a password gate. None of it is an
 * application requirement. A fork with a different setup empties this object;
 * the format checks and combination rules still apply.
 */
export const DEPLOYMENT_TOPOLOGY = {
  // Both set MONGODB_URI, so without this they would switch to standalone.
  APP_MODE: ['prod', 'preview'],
  TOGGL_API_TOKEN: ['prod', 'preview'],
  APP_PASSWORD: ['prod', 'preview'],
  MONGODB_URI: ['prod', 'preview'],
  // Preview shares production's connection string; only the database name
  // keeps it out of production data.
  MONGODB_DB: ['preview'],
  // Without the pack the build succeeds but loses every template in use.
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
      '"toggl" keeps Toggl as the data source when MONGODB_URI is set, so the database holds synced settings only. Without it, MONGODB_URI switches the app to standalone mode.',
    check: (value) =>
      value === 'toggl'
        ? null
        : 'must be "toggl" or empty. Any other value leaves the app in standalone mode',
  },

  // -- Toggl ------------------------------------------------------------------
  {
    name: 'TOGGL_API_TOKEN',
    scope: 'server',
    description:
      'Toggl Track API token from https://track.toggl.com/profile. When set, the server holds the token and Settings hides the token field. Ignored in standalone mode.',
    check: (value) => {
      if (/\s/.test(value)) return 'must not contain whitespace (often a newline from copy-paste)';
      return value.length >= 20 && value.length <= 64 ? null : 'does not look like a Toggl API token (expected ~32 characters)';
    },
  },
  {
    name: 'TOGGL_CACHE_INTERVAL',
    scope: 'server',
    description:
      'Seconds between Toggl refreshes for the shared server-side cache, or 1/true/on/yes for the 180s default. Needs TOGGL_API_TOKEN and Toggl mode. While set, Settings hides the per-device "Refresh interval" picker.',
    check: mustBeCacheInterval,
  },

  // -- Database ---------------------------------------------------------------
  {
    name: 'MONGODB_URI',
    scope: 'server',
    description:
      'MongoDB connection string. On its own it switches the app to standalone mode; with APP_MODE=toggl it enables settings sync. Either way it needs APP_PASSWORD.',
    check: mustBeMongoUri,
  },
  {
    name: 'MONGODB_DB',
    scope: 'server',
    description:
      'Database name. Defaults to "toggl-quick-view"; a database in the connection-string path is ignored. Required in preview, which shares production\'s connection string: this name is all that keeps preview out of production data.',
    check: mustBeDbName,
  },

  // -- Access -----------------------------------------------------------------
  {
    name: 'APP_PASSWORD',
    scope: 'server',
    description:
      'Password for the whole dashboard. Required with MONGODB_URI (those routes write). Recommended with TOGGL_API_TOKEN, or anyone with the URL can read your time entries.',
    check: (value) =>
      value.length >= 8
        ? null
        : 'should be at least 8 characters',
  },

  // -- PDF template pack (build time only) ------------------------------------
  {
    name: 'PDF_TEMPLATE_PACK_REPO',
    scope: 'server',
    description:
      'Git remote of an optional PDF template pack, checked out into pdf-templates/ before the build. Empty, the app offers only its own templates. Read at build time, so a change needs a redeploy. Deployments need the https form (no ssh key in a Vercel build).',
    check: mustBeGitRemote,
  },
  {
    name: 'PDF_TEMPLATE_PACK_REF',
    scope: 'server',
    description:
      'Branch, tag or commit of the template pack. Defaults to "main". Pin a commit if pack changes should not reach the next deployment on their own.',
    check: (value) =>
      /\s/.test(value) ? 'must not contain whitespace' : null,
  },
  {
    name: 'PDF_TEMPLATE_PACK_TOKEN',
    scope: 'server',
    description:
      'Token that can read PDF_TEMPLATE_PACK_REPO over https: a GitHub fine-grained PAT with Contents: Read on that repository. Needed for a private pack in every deployment.',
    check: (value) =>
      /\s/.test(value) ? 'must not contain whitespace (often a newline from copy-paste)' : null,
  },

  // -- Signing ----------------------------------------------------------------
  {
    name: 'TSA_URL',
    scope: 'server',
    description:
      'RFC 3161 timestamp authority, proxied by /api/timestamp. When set, signed PDF exports are PAdES-B-T instead of B-B and keep verifying after the signing certificate expires. Empty turns timestamping off; signing still works. Only an authority on the EU Trust List passes the EU DSS validator cleanly; see docs/pdf-signing-v2.md.',
    check: mustBeTsaUrl,
  },
  {
    name: 'TSA_CREDENTIALS',
    scope: 'server',
    description:
      'HTTP Basic credentials (user:password) for a commercial timestamp authority. Ignored without TSA_URL.',
    check: (value) =>
      value.includes(':') ? null : 'must be user:password',
  },
];

/** Set by the platform, a script or machine tooling. Not listed in the templates. */
export const EXTERNAL_ENV = {
  platform: ['NODE_ENV', 'PORT', 'CI', 'VERCEL', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA'],
  // Computed in next.config.js at build time.
  derived: ['NEXT_PUBLIC_BUILD_ID', 'NEXT_PUBLIC_VERCEL_ENV'],
  // scripts/check-windows.ts sets TZ per case to test DST boundaries.
  scriptFlags: ['TZ'],
  // OP_SERVICE_ACCOUNT_TOKEN belongs in the shell profile, not in .env.
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

/** The value of a variable, trimmed; empty when unset. Shared with check-env.mjs. */
export const present = (env, name) => (env[name] ?? '').trim();

/** What `vercel env pull` writes for a Sensitive variable, whose value it cannot read. */
const PULLED_PLACEHOLDER = '[SENSITIVE]';

/** What a 1Password field holds for a secret not yet recovered. */
const UNSET_PLACEHOLDER = 'replaceMe';

/**
 * @param {Record<string, string | undefined>} env
 * @param {EnvEnvironment} [environment] Defaults to 'dev' (local `pnpm env:check`).
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
    // A file full of these looks configured and fails at the service.
    if (value === PULLED_PLACEHOLDER) {
      errors.push(
        `${spec.name} is the "${PULLED_PLACEHOLDER}" placeholder from \`vercel env pull\`, not a real value. Get it from the service that issued it.`
      );
      continue;
    }
    if (value === UNSET_PLACEHOLDER) {
      errors.push(
        `${spec.name} is still "${UNSET_PLACEHOLDER}": the 1Password field has no real value yet.`
      );
      continue;
    }
    // Left over from `cp .env.tpl .env`. For APP_PASSWORD this matters: an
    // op:// string is public in git and long enough to pass the length check.
    if (value.startsWith('op://')) {
      errors.push(
        `${spec.name} is an unresolved 1Password reference. Run \`pnpm env:pull\`, or replace it with the real value.`
      );
      continue;
    }
    // Never echo the value: many of these are secrets.
    const problem = spec.check?.(value);
    if (problem) errors.push(`${spec.name} ${problem}.`);
  }

  // -- Cross-variable rules ---------------------------------------------------
  // These mirror lib/store/mongo.ts, lib/sync/server.ts, lib/serverAuth.ts and
  // lib/serverCache.ts. Keep them in step.

  const uri = present(env, 'MONGODB_URI');
  const password = present(env, 'APP_PASSWORD');
  const token = present(env, 'TOGGL_API_TOKEN');
  const mode = present(env, 'APP_MODE');
  const interval = present(env, 'TOGGL_CACHE_INTERVAL');
  const dbName = present(env, 'MONGODB_DB');
  const standalone = Boolean(uri) && mode !== 'toggl';

  // The app would boot, report itself misconfigured and refuse the store or
  // sync routes. Fail the build instead.
  if (uri && !password) {
    errors.push(
      standalone
        ? 'MONGODB_URI is set without APP_PASSWORD: the app is in standalone mode and every store route will refuse requests. Set APP_PASSWORD, or unset MONGODB_URI.'
        : 'MONGODB_URI is set without APP_PASSWORD, so settings sync stays off (it writes, so it needs a password). Set APP_PASSWORD, or unset MONGODB_URI.'
    );
  }

  // gateEnabled() needs a server-held token or a database to protect.
  if (password && !token && !uri) {
    warnings.push(
      'APP_PASSWORD has no effect: with neither TOGGL_API_TOKEN nor MONGODB_URI set, there is nothing on the server to protect.'
    );
  }

  // A warning, not an error: a public dashboard is allowed. Skipped in dev,
  // where no password is the default and nobody else can reach the server.
  if (token && !password && environment !== 'dev') {
    warnings.push(
      'TOGGL_API_TOKEN is set without APP_PASSWORD: anyone with this deployment\'s URL can see your time entries.'
    );
  }

  if (mode === 'toggl' && !uri) {
    warnings.push(
      'APP_MODE=toggl has no effect without MONGODB_URI. Was MONGODB_URI meant to be set?'
    );
  }

  if (dbName && !uri) {
    warnings.push(
      `MONGODB_DB is "${dbName}" but MONGODB_URI is not set, so no database is opened.`
    );
  }

  // cacheIntervalSec() is used only for the server-held token in Toggl mode.
  if (interval && !token) {
    warnings.push(
      'TOGGL_CACHE_INTERVAL has no effect without TOGGL_API_TOKEN: the shared cache only serves the server-held token.'
    );
  } else if (interval && standalone) {
    warnings.push(
      'TOGGL_CACHE_INTERVAL has no effect in standalone mode. Add APP_MODE=toggl if Toggl should stay the source.'
    );
  }

  // Free plan: 30 requests/hour, one per 120s. The app accepts anything down to
  // its 30s floor, so a too-short interval only shows up as 429s.
  if (interval && !BOOLISH.test(interval)) {
    const seconds = Number.parseInt(interval, 10);
    if (Number.isFinite(seconds) && seconds > 0 && seconds < 120) {
      warnings.push(
        `TOGGL_CACHE_INTERVAL is ${seconds}s, about ${Math.round(3600 / seconds)} Toggl requests/hour, over the Free plan's 30. Use 120 or more.`
      );
    }
  }

  // -- PDF template pack (acted on by scripts/sync-pack.mjs) --

  const packRepo = present(env, 'PDF_TEMPLATE_PACK_REPO');
  const packRef = present(env, 'PDF_TEMPLATE_PACK_REF');
  const packToken = present(env, 'PDF_TEMPLATE_PACK_TOKEN');

  if (packRepo && environment !== 'dev' && isSshRemote(packRepo)) {
    // A build has no ssh key; sync-pack.mjs would fail a minute later.
    errors.push(
      'PDF_TEMPLATE_PACK_REPO is an ssh remote, which a deployment cannot fetch (no ssh key in the build). Use the https form and set PDF_TEMPLATE_PACK_TOKEN.'
    );
  } else if (packRepo && !packToken && !isSshRemote(packRepo)) {
    warnings.push(
      'PDF_TEMPLATE_PACK_REPO is https with no PDF_TEMPLATE_PACK_TOKEN. Fine for a public pack; a private one will fail the checkout and the build.'
    );
  }

  if (packToken && !packRepo) {
    warnings.push(
      'PDF_TEMPLATE_PACK_TOKEN has no effect without PDF_TEMPLATE_PACK_REPO.'
    );
  }

  if (packRef && !packRepo) {
    warnings.push(
      `PDF_TEMPLATE_PACK_REF is "${packRef}" but has no effect without PDF_TEMPLATE_PACK_REPO.`
    );
  }

  // Only the Toggl proxy reads the token, and standalone mode never uses it.
  if (token && standalone) {
    warnings.push(
      'TOGGL_API_TOKEN is ignored: MONGODB_URI without APP_MODE=toggl puts the app in standalone mode, which does not use Toggl.'
    );
  }

  return { errors, warnings };
}
