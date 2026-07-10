import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

/**
 * Whether the process is running under OneCLI credential-gateway mode.
 * When set, outbound HTTP should route through HTTPS_PROXY (set by
 * `onecli run`) so the gateway can inject vaulted credentials.
 */
export function isOneCliMode() {
  return Boolean(process.env.ONECLI_URL);
}

/**
 * Install a global undici ProxyAgent so every global `fetch` routes through
 * `HTTPS_PROXY`. No-op when `ONECLI_URL` is unset — no ProxyAgent, no
 * dispatcher swap; HTTP routing matches pre-OneCLI behavior.
 *
 * Call once, early (from sync.mjs), before any HTTP.
 *
 * Relies on `onecli run` setting:
 *   - HTTPS_PROXY        → the gateway proxy URL
 *   - NODE_EXTRA_CA_CERTS → path to the MITM CA (Node trusts this at startup
 *     for both `https` and undici on Node ≥ 20.6)
 *
 * If `NODE_EXTRA_CA_CERTS` is set we also pass it as `requestTls.ca` so
 * callers that somehow launch without the env var being read at process
 * start still trust the MITM CA.
 *
 * @returns {ProxyAgent|null} the installed agent, or null when not in OneCLI mode
 * @throws {Error} when ONECLI_URL is set but HTTPS_PROXY is missing, or when
 *   NODE_EXTRA_CA_CERTS is set but the path is missing/unreadable
 */
export function installProxyDispatcher() {
  if (!isOneCliMode()) return null;

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) {
    throw new Error(
      'ONECLI_URL is set but HTTPS_PROXY is not — run via `onecli run` ' +
      '(e.g. `onecli run node sync.mjs`) so the gateway proxy and MITM CA ' +
      'are injected into the process environment.',
    );
  }

  const agentOpts = { uri: proxyUrl };

  // Belt-and-suspenders CA trust for callers that don't get NODE_EXTRA_CA_CERTS
  // applied at process start (e.g. tests that set the env after Node boots).
  // Node itself already *appends* NODE_EXTRA_CA_CERTS to the default trust
  // store when the process launches via `onecli run`. Passing `ca` to
  // undici/TLS *replaces* the default store, so we must append the extra
  // cert to tls.rootCertificates rather than using it alone — otherwise
  // public roots drop and non-MITM / pass-through TLS can fail.
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  if (caPath) {
    try {
      const extraCa = readFileSync(caPath);
      const ca = [...tls.rootCertificates, extraCa];
      agentOpts.requestTls = { ca, rejectUnauthorized: true };
      agentOpts.proxyTls = { ca, rejectUnauthorized: true };
    } catch (err) {
      throw new Error(
        `Failed to read NODE_EXTRA_CA_CERTS (${caPath}): ${err.message}`,
      );
    }
  }

  const agent = new ProxyAgent(agentOpts);
  setGlobalDispatcher(agent);
  return agent;
}

/**
 * Restore the previous global dispatcher. Used by tests to avoid leaking
 * ProxyAgent state across cases.
 */
export function resetProxyDispatcher(previous) {
  if (previous) {
    setGlobalDispatcher(previous);
  }
}

export { getGlobalDispatcher, ProxyAgent };
