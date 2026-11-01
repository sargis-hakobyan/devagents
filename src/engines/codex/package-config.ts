import { lstat, readFile } from 'node:fs/promises';

/** A repository .npmrc is often ordinary build configuration. Expose only understood,
 * non-secret values, read-only; never heuristically declare arbitrary config credential-free.
 * Unknown settings and authentication-bearing files retain the protected-path denial.
 */
export async function publicPackageConfig(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.nlink > 1 || info.size > 64 * 1024) return false;
  const booleanKeys = /^(?:auto-install-peers|strict-peer-dependencies|engine-strict|shamefully-hoist|hoist|shared-workspace-lockfile|link-workspace-packages|prefer-workspace-packages|save-workspace-protocol|ignore-scripts|ignore-pnpmfile|manage-package-manager-versions|package-manager-strict|package-manager-strict-version|enable-pre-post-scripts|side-effects-cache|verify-store-integrity|recursive-install|include-workspace-root|lockfile|prefer-frozen-lockfile|fund|audit|update-notifier|strict-ssl)$/;
  for (const raw of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([a-z-]+)=([^\r\n]*)$/.exec(line);
    if (!match) return false;
    const [, key, value] = match;
    if (booleanKeys.test(key!) && /^(?:true|false)$/.test(value!)) continue;
    if (key === 'node-linker' && /^(?:hoisted|isolated|pnp)$/.test(value!)) continue;
    if (key === 'package-import-method' && /^(?:auto|copy|clone|hardlink|clone-or-copy)$/.test(value!)) continue;
    if (/^(?:network-concurrency|child-concurrency|workspace-concurrency)$/.test(key!) && /^\d{1,4}$/.test(value!)) continue;
    return false;
  }
  return true;
}
