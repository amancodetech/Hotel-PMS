import { parseEnv } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const env = {
  ...parseEnv(readFileSync('.env', 'utf8')),
  ...process.env,
};
const required = [
  'KEYCLOAK_ISSUER',
  'KEYCLOAK_CLIENT_ID',
  'KEYCLOAK_CLIENT_SECRET',
  'KEYCLOAK_ADMIN_PASSWORD',
  'KEYCLOAK_TEST_USER_PASSWORD',
  'KEYCLOAK_MFA_USER_PASSWORD',
  'KEYCLOAK_MFA_TOTP_KEY',
  'KEYCLOAK_ADMIN_TOTP_KEY',
  'KEYCLOAK_PLATFORM_TOTP_KEY',
  'API_PORT',
  'WEB_PORT',
];
for (const key of required)
  if (!env[key]) throw new Error(`Missing ${key}; run pnpm env:init`);

const issuer = new URL(env.KEYCLOAK_ISSUER);
const origin = issuer.origin;
const realmName = issuer.pathname.split('/').filter(Boolean).at(-1);
const webOrigin = `http://127.0.0.1:${env.WEB_PORT}`;
const redirectUri = `http://127.0.0.1:${env.API_PORT}/api/v1/auth/callback`;

async function adminToken() {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: 'local-admin',
    password: env.KEYCLOAK_ADMIN_PASSWORD,
  });
  const response = await fetch(
    `${origin}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (!response.ok)
    throw new Error(`Keycloak admin login failed with ${response.status}`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error('Keycloak admin login failed');
  return payload.access_token;
}

const token = await adminToken();
async function api(method, path, body) {
  const response = await fetch(`${origin}/admin/realms${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok && response.status !== 409)
    throw new Error(
      `Keycloak ${method} ${path} failed with ${response.status}: ${String(text).slice(0, 200)}`,
    );
  return data;
}

const realm = await api('GET', `/${realmName}`).catch(() => null);
if (!realm) {
  await api('POST', '', {
    realm: realmName,
    enabled: true,
    sslRequired: 'external',
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: false,
    verifyEmail: false,
  });
}

const realmRoleName = 'hotel-mfa-required';
let realmRole = await api('GET', `/${realmName}/roles/${realmRoleName}`).catch(
  () => null,
);
if (!realmRole) {
  await api('POST', `/${realmName}/roles`, {
    name: realmRoleName,
    description:
      'Local synthetic role marking identities that must complete a second factor (conditional OTP flow).',
  });
  realmRole = await api('GET', `/${realmName}/roles/${realmRoleName}`);
}

const clientRepresentation = {
  clientId: env.KEYCLOAK_CLIENT_ID,
  name: 'HOTEL PMS local API (BFF)',
  enabled: true,
  protocol: 'openid-connect',
  publicClient: false,
  clientAuthenticatorType: 'client-secret',
  secret: env.KEYCLOAK_CLIENT_SECRET,
  standardFlowEnabled: true,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  redirectUris: [redirectUri],
  webOrigins: [webOrigin],
  attributes: {
    'post.logout.redirect.uris': `${webOrigin}/login`,
    'pkce.code.challenge.method': 'S256',
  },
};
const clients = await api(
  'GET',
  `/${realmName}/clients?clientId=${encodeURIComponent(env.KEYCLOAK_CLIENT_ID)}`,
);
const existingClient = clients?.[0];
if (existingClient) {
  await api('PUT', `/${realmName}/clients/${existingClient.id}`, {
    ...existingClient,
    ...clientRepresentation,
  });
} else {
  await api('POST', `/${realmName}/clients`, clientRepresentation);
}

async function ensureAmrMapper() {
  const client = (
    await api(
      'GET',
      `/${realmName}/clients?clientId=${encodeURIComponent(env.KEYCLOAK_CLIENT_ID)}`,
    )
  )?.[0];
  if (!client) throw new Error('BFF client missing before mapper setup');
  const mappers = await api(
    'GET',
    `/${realmName}/clients/${client.id}/protocol-mappers/models`,
  );
  if (mappers.some((mapper) => mapper.protocolMapper === 'oidc-amr-mapper'))
    return;
  await api(
    'POST',
    `/${realmName}/clients/${client.id}/protocol-mappers/models`,
    {
      name: 'amr',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-amr-mapper',
      consentRequired: false,
      config: {
        'access.token.claim': 'true',
        'id.token.claim': 'true',
        'introspection.token.claim': 'true',
      },
    },
  );
}
await ensureAmrMapper();

const flowAlias = 'browser-mfa';
const flowConditionAlias = 'hotel-mfa-role-condition';
async function ensureBrowserFlow() {
  const flows = await api('GET', `/${realmName}/authentication/flows`);
  if (!flows.some((flow) => flow.alias === flowAlias))
    await api('POST', `/${realmName}/authentication/flows/browser/copy`, {
      newName: flowAlias,
    });
  const executions = await api(
    'GET',
    `/${realmName}/authentication/flows/${flowAlias}/executions`,
  );
  const conditional = executions.find(
    (execution) =>
      execution.authenticationFlow &&
      String(execution.displayName).includes('Conditional 2FA'),
  );
  if (!conditional)
    throw new Error('Copied browser flow has no conditional 2FA subflow');
  const condition = executions.find(
    (execution) => execution.providerId === 'conditional-user-role',
  );
  if (!condition) {
    await api('POST', `/${realmName}/authentication/executions`, {
      authenticator: 'conditional-user-role',
      requirement: 'REQUIRED',
      parentFlow: conditional.flowId,
    });
  }
  const refreshed = await api(
    'GET',
    `/${realmName}/authentication/flows/${flowAlias}/executions`,
  );
  const added = refreshed.find(
    (execution) => execution.providerId === 'conditional-user-role',
  );
  if (!added) throw new Error('MFA role condition was not created');
  const configBody = {
    alias: flowConditionAlias,
    config: { condUserRole: realmRoleName },
  };
  if (added.authenticationConfig)
    await api(
      'PUT',
      `/${realmName}/authentication/config/${added.authenticationConfig}`,
      { id: added.authenticationConfig, ...configBody },
    );
  else
    await api(
      'POST',
      `/${realmName}/authentication/executions/${added.id}/config`,
      configBody,
    );
  const current = await api('GET', `/${realmName}`);
  if (current.browserFlow !== flowAlias)
    await api('PUT', `/${realmName}`, { ...current, browserFlow: flowAlias });
  await ensureAmrExecution(
    refreshed,
    'auth-username-password-form',
    'hotel-amr-password',
    'pwd',
  );
  await ensureAmrExecution(refreshed, 'auth-otp-form', 'hotel-amr-otp', 'otp');
}

async function ensureAmrExecution(executions, providerId, alias, reference) {
  const execution = executions.find((entry) => entry.providerId === providerId);
  if (!execution) throw new Error(`Missing ${providerId} in ${flowAlias}`);
  const config = {
    alias,
    config: {
      'default.reference.value': reference,
      'default.reference.maxAge': '3600',
    },
  };
  if (execution.authenticationConfig) {
    const existing = await api(
      'GET',
      `/${realmName}/authentication/config/${execution.authenticationConfig}`,
    );
    const merged = { ...(existing?.config ?? {}), ...config.config };
    delete merged.authenticatorReferenceValue;
    delete merged.authenticatorReferenceMaxAge;
    if (JSON.stringify(merged) !== JSON.stringify(existing?.config)) {
      await api(
        'PUT',
        `/${realmName}/authentication/config/${execution.authenticationConfig}`,
        {
          id: execution.authenticationConfig,
          alias: existing?.alias ?? alias,
          config: merged,
        },
      );
    }
    return;
  }
  await api(
    'POST',
    `/${realmName}/authentication/executions/${execution.id}/config`,
    config,
  );
}
await ensureBrowserFlow();

async function ensureUser({
  username,
  email,
  firstName,
  password,
  mfa = false,
  totpKey = null,
}) {
  const search = await api(
    'GET',
    `/${realmName}/users?username=${encodeURIComponent(username)}&exact=true`,
  );
  let user = search?.[0];
  const body = {
    username,
    email,
    firstName,
    lastName: 'Synthetic',
    enabled: true,
    emailVerified: true,
  };
  if (!user) {
    await api('POST', `/${realmName}/users`, {
      ...body,
      credentials: [{ type: 'password', value: password, temporary: false }],
    });
    const created = await api(
      'GET',
      `/${realmName}/users?username=${encodeURIComponent(username)}&exact=true`,
    );
    user = created?.[0];
  } else {
    await api('PUT', `/${realmName}/users/${user.id}`, { ...user, ...body });
    await api('PUT', `/${realmName}/users/${user.id}/reset-password`, {
      type: 'password',
      value: password,
      temporary: false,
    });
  }
  if (!user) throw new Error(`Failed to provision ${username}`);
  if (mfa) {
    await api('POST', `/${realmName}/users/${user.id}/role-mappings/realm`, [
      { id: realmRole.id, name: realmRole.name },
    ]).catch(async () => {
      const mappings = await api(
        'GET',
        `/${realmName}/users/${user.id}/role-mappings/realm`,
      );
      if (!mappings.some((mapping) => mapping.name === realmRoleName))
        throw new Error(`Failed to assign MFA role to ${username}`);
    });
    const credentials = await api(
      'GET',
      `/${realmName}/users/${user.id}/credentials`,
    );
    const matchesKey = credentials.some(
      (credential) =>
        credential.type === 'otp' &&
        typeof credential.secretData === 'string' &&
        credential.secretData.includes(totpKey),
    );
    if (!matchesKey) {
      for (const credential of credentials)
        if (credential.type === 'otp')
          await api(
            'DELETE',
            `/${realmName}/users/${user.id}/credentials/${credential.id}`,
          );
      await api('PUT', `/${realmName}/users/${user.id}`, {
        ...user,
        requiredActions: [],
        credentials: [
          {
            type: 'otp',
            userLabel: 'local-totp',
            credentialData: JSON.stringify({
              subType: 'totp',
              digits: 6,
              period: 30,
              algorithm: 'HmacSHA1',
            }),
            secretData: JSON.stringify({ value: totpKey }),
          },
        ],
      });
    } else {
      await api('PUT', `/${realmName}/users/${user.id}`, {
        ...user,
        requiredActions: [],
      });
    }
  }
  return user;
}

const testPassword = env.KEYCLOAK_TEST_USER_PASSWORD;
const users = {};
users['owner-a'] = await ensureUser({
  username: 'owner-a',
  email: 'owner-a@local.test',
  firstName: 'Owner A',
  password: testPassword,
});
users['admin-a'] = await ensureUser({
  username: 'admin-a',
  email: 'admin-a@local.test',
  firstName: 'Admin A',
  password: testPassword,
  mfa: true,
  totpKey: env.KEYCLOAK_ADMIN_TOTP_KEY,
});
users['member-a'] = await ensureUser({
  username: 'member-a',
  email: 'member-a@local.test',
  firstName: 'Member A',
  password: testPassword,
});
users['viewer-v'] = await ensureUser({
  username: 'viewer-v',
  email: 'viewer-v@local.test',
  firstName: 'Viewer V',
  password: testPassword,
});
users['auditor-a'] = await ensureUser({
  username: 'auditor-a',
  email: 'auditor-a@local.test',
  firstName: 'Auditor A',
  password: testPassword,
});
users['owner-b'] = await ensureUser({
  username: 'owner-b',
  email: 'owner-b@local.test',
  firstName: 'Owner B',
  password: testPassword,
});
users['mfa-a'] = await ensureUser({
  username: 'mfa-a',
  email: 'mfa-a@local.test',
  firstName: 'MFA A',
  password: env.KEYCLOAK_MFA_USER_PASSWORD,
  mfa: true,
  totpKey: env.KEYCLOAK_MFA_TOTP_KEY,
});
// Synthetic platform staff with no tenant membership at all. platform-a and
// platform-s complete OTP (sensitive platform actions require MFA), while
// platform-b intentionally has no second factor so SEC-007 can be probed.
users['platform-a'] = await ensureUser({
  username: 'platform-a',
  email: 'platform-a@local.test',
  firstName: 'Platform A',
  password: testPassword,
  mfa: true,
  totpKey: env.KEYCLOAK_PLATFORM_TOTP_KEY,
});
users['platform-b'] = await ensureUser({
  username: 'platform-b',
  email: 'platform-b@local.test',
  firstName: 'Platform B',
  password: testPassword,
});
users['platform-s'] = await ensureUser({
  username: 'platform-s',
  email: 'platform-s@local.test',
  firstName: 'Platform Support',
  password: testPassword,
  mfa: true,
  totpKey: env.KEYCLOAK_PLATFORM_TOTP_KEY,
});
mkdirSync('.local', { recursive: true, mode: 0o700 });
writeFileSync(
  '.local/identity-users.json',
  `${JSON.stringify(
    {
      realm: realmName,
      issuer: issuer.href.replace(/\/$/, ''),
      users: Object.fromEntries(
        Object.entries(users).map(([username, user]) => [
          username,
          { id: user.id, email: user.email },
        ]),
      ),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const discovery = await fetch(
  `${issuer.origin}${issuer.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`,
);
const metadata = discovery.ok ? await discovery.json() : null;
if (!metadata || metadata.issuer !== issuer.href.replace(/\/$/, ''))
  throw new Error(
    'Identity realm discovery does not match the configured issuer',
  );
const finalRealm = await api('GET', `/${realmName}`);
if (finalRealm.browserFlow !== flowAlias)
  throw new Error('Realm browser flow is not enforcing the MFA policy');
console.log(
  `Identity realm "${realmName}" ready: BFF client, conditional-OTP browser flow (${flowAlias}), synthetic test users. No credentials printed.`,
);
