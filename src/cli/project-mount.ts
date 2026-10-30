import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Id } from '../domain/schemas.js';
const Volume = z.object({ type: z.literal('bind'), source: z.string(), target: z.string().regex(/^\/projects\/[a-z][a-z0-9-]{0,63}$/), bind: z.object({ create_host_path: z.literal(false) }).strict() }).strict();
const Managed = z.object({ services: z.object({ devagents: z.object({ volumes: z.array(Volume) }).strict() }).strict() }).strict();
/** Only our generated mount file is edited; user Compose overrides are never rewritten. */
export function projectMount(previous: string, id: string, hostPath: string): string {
  Id.parse(id);
  if (!hostPath.startsWith('/') || hostPath === '/' || /[\r\n\0,]/.test(hostPath)) throw new Error('Choose an absolute project directory without commas or line breaks.');
  const source = hostPath.replaceAll('$', () => '$$'); // Compose interpolation must not change a literal host path.
  const target = `/projects/${id}`;
  const volumes = previous.trim() ? Managed.parse(parse(previous)).services.devagents.volumes : [];
  const existing = volumes.find(v => v.target === target);
  if (existing && existing.source !== source) throw new Error('That project ID already mounts a different folder. Choose another ID.');
  if (volumes.some(v => v.source === source && v.target !== target)) throw new Error('That folder is already mounted under another project ID.');
  if (!existing) volumes.push({ type: 'bind', source, target, bind: { create_host_path: false } });
  return stringify({ services: { devagents: { volumes } } });
}
export function checkExistingMounts(effective: unknown, id: string, hostPath: string): void {
  Id.parse(id);
  const config = effective as { services?: { devagents?: { volumes?: { target: string; source?: string }[] } } };
  for (const volume of config.services?.devagents?.volumes ?? []) {
    if (volume.target === `/projects/${id}` && volume.source !== hostPath) throw new Error('That target already has a different mount.');
    if (volume.source === hostPath && volume.target !== `/projects/${id}`) throw new Error('That folder is already mounted elsewhere.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new Error('Managed project configuration is too large'); }
  try {
    if (process.argv[2] === '--check') checkExistingMounts(JSON.parse(input), process.argv[3] ?? '', process.argv[4] ?? '');
    else process.stdout.write(projectMount(input, process.argv[2] ?? '', process.argv[3] ?? ''));
  }
  catch { console.error('Could not add the project mount. Check the project ID, path and existing managed mounts.'); process.exitCode = 1; }
}
