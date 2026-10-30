import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Id } from '../domain/schemas.js';
const Volume = z.object({ type: z.literal('bind'), source: z.string(), target: z.string().regex(/^\/projects\/[a-z][a-z0-9-]{0,63}$/), bind: z.object({ create_host_path: z.literal(false) }).strict() }).strict();
const Managed = z.object({ services: z.object({ devagents: z.object({ volumes: z.array(Volume) }).strict() }).strict() }).strict();
class ProjectMountError extends Error {}
function validateId(id: string) {
  if (!Id.safeParse(id).success) throw new ProjectMountError('Project ID must start with a lowercase letter and contain only lowercase letters, digits or dashes (at most 64 characters).');
}
/** Only our generated mount file is edited; user Compose overrides are never rewritten. */
export function projectMount(previous: string, id: string, hostPath: string): string {
  validateId(id);
  if (!hostPath.startsWith('/') || hostPath === '/' || /[\r\n\0,]/.test(hostPath)) throw new ProjectMountError('Choose an absolute project directory without commas or line breaks.');
  const source = hostPath.replaceAll('$', () => '$$'); // Compose interpolation must not change a literal host path.
  const target = `/projects/${id}`;
  const volumes = previous.trim() ? Managed.parse(parse(previous)).services.devagents.volumes : [];
  const existing = volumes.find(v => v.target === target);
  if (existing && existing.source !== source) throw new ProjectMountError('That project ID already mounts a different folder. Choose another ID.');
  if (volumes.some(v => v.source === source && v.target !== target)) throw new ProjectMountError('That folder is already mounted under another project ID.');
  if (!existing) volumes.push({ type: 'bind', source, target, bind: { create_host_path: false } });
  return stringify({ services: { devagents: { volumes } } });
}
export function checkExistingMounts(effective: unknown, id: string, hostPath: string): void {
  validateId(id);
  const config = effective as { services?: { devagents?: { volumes?: { target: string; source?: string }[] } } };
  for (const volume of config.services?.devagents?.volumes ?? []) {
    if (volume.target === `/projects/${id}` && volume.source !== hostPath) throw new ProjectMountError('That project ID already has a different mount. Choose another ID.');
    if (volume.source === hostPath && volume.target !== `/projects/${id}`) throw new ProjectMountError('That folder is already mounted under another project ID. Use its existing registration.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new ProjectMountError('Managed project configuration exceeds the 64 KiB limit.'); }
    if (process.argv[2] === '--check') checkExistingMounts(JSON.parse(input), process.argv[3] ?? '', process.argv[4] ?? '');
    else process.stdout.write(projectMount(input, process.argv[2] ?? '', process.argv[3] ?? ''));
  }
  catch (error) { console.error(error instanceof ProjectMountError ? error.message : 'Could not read the project mount configuration. Check the Compose configuration and existing managed mounts.'); process.exitCode = 1; }
}
