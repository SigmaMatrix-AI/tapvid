// Secrets: the environment variable of the same name wins, then the platform store
// (macOS Keychain / Windows DPAPI file, spec §2.1). Values never reach logs or files.
import { platform as defaultPlatform } from '../platform.mjs';

export function createSecrets({ env = process.env, platform = defaultPlatform } = {}) {
  const memo = new Map();
  function secret(name) {
    if (env[name]) return env[name];
    if (!memo.has(name)) memo.set(name, platform.readSecret(name));
    return memo.get(name);
  }
  // A provider is configured when every secret it declares is present.
  const configured = (provider) => (provider.meta.secrets || []).every((n) => Boolean(secret(n)));
  return { secret, configured };
}
