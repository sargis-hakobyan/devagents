import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ProjectId } from '../domain/schemas.js';
const Volume = z.object({ type: z.literal('bind'), source: z.string(), target: z.string().regex(/^\/projects\/[a-z0-9][a-z0-9-]{0,63}$/), bind: z.object({ create_host_path: z.literal(false) }).strict() }).strict();
const Managed = z.object({ services: z.object({ devagents: z.object({ volumes: z.array(Volume) }).strict() }).strict() }).strict();
class ProjectMountError extends Error {}
function validateId(id: string) {
  if (!ProjectId.safeParse(id).success) throw new ProjectMountError('Project ID must contain only lowercase letters, digits or dashes (at most 64 characters).');
}
/** Only our generated mount file is edited; user Compose overrides are never rewritten. */
/** What the launcher knows from the service, by mount target: archived projects may share their folder, and names make the message readable. */
export type MountInfo = { archived?: readonly string[]; names?: Readonly<Record<string, string>> };
const taken = (target: string, info: MountInfo) => { const name = info.names?.[target] ?? target.slice('/projects/'.length); return new ProjectMountError(`That folder is already registered as project "${name}". Use it, or archive it first: ./devagents project archive --name '${name.replaceAll("'", `'"'"'`)}'`); };
/** A folder held only by archived projects may be mounted again for a new project; their own mounts stay for their history. */
export function projectMount(previous: string, id: string, hostPath: string, info: MountInfo = {}): string {
  validateId(id);
  if (!hostPath.startsWith('/') || hostPath === '/' || /[\r\n\0,]/.test(hostPath)) throw new ProjectMountError('Choose an absolute project directory without commas or line breaks.');
  const source = hostPath.replaceAll('$', () => '$$'); // Compose interpolation must not change a literal host path.
  const target = `/projects/${id}`;
  const volumes = previous.trim() ? Managed.parse(parse(previous)).services.devagents.volumes : [];
  const existing = volumes.find(v => v.target === target);
  if (existing && existing.source !== source) throw new ProjectMountError('That project ID already mounts a different folder. Choose another ID.');
  const archived = info.archived ?? [];
  const holder = volumes.find(v => v.source === source && v.target !== target && !archived.includes(v.target));
  if (holder) throw taken(holder.target, info);
  if (!existing) volumes.push({ type: 'bind', source, target, bind: { create_host_path: false } });
  return stringify({ services: { devagents: { volumes } } });
}
/** The ID of a managed mount of this folder that no project is registered on, left behind when setup stopped between mounting and registering. */
export function orphanMount(previous: string, hostPath: string, info: MountInfo = {}): string | undefined {
  const source = hostPath.replaceAll('$', () => '$$');
  const volumes = previous.trim() ? Managed.parse(parse(previous)).services.devagents.volumes : [];
  return volumes.find(v => v.source === source && !(v.target in (info.names ?? {})))?.target.slice('/projects/'.length);
}
/** Internal path to host folder for every project mount in the effective Compose configuration. */
export function hostFolders(effective: unknown): Record<string, string> {
  const config = effective as { services?: { devagents?: { volumes?: { target?: unknown; source?: unknown; type?: unknown }[] } } };
  const folders: Record<string, string> = {};
  for (const volume of config?.services?.devagents?.volumes ?? []) {
    if (volume?.type === 'bind' && typeof volume.target === 'string' && typeof volume.source === 'string' && volume.target.startsWith('/projects/') && volume.source.startsWith('/')) folders[volume.target] = volume.source;
  }
  return folders;
}
export function checkExistingMounts(effective: unknown, id: string, hostPath: string, info: MountInfo = {}): void {
  validateId(id); const archived = info.archived ?? [];
  const config = effective as { services?: { devagents?: { volumes?: { target: string; source?: string }[] } } };
  for (const volume of config.services?.devagents?.volumes ?? []) {
    if (volume.target === `/projects/${id}` && volume.source !== hostPath) throw new ProjectMountError('That project ID already has a different mount. Choose another ID.');
    if (volume.source === hostPath && volume.target !== `/projects/${id}` && !archived.includes(volume.target)) throw volume.target.startsWith('/projects/') ? taken(volume.target, info) : new ProjectMountError('That folder is already mounted elsewhere in the service.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new ProjectMountError('Managed project configuration exceeds the 64 KiB limit.'); }
    const info = (value: string | undefined): MountInfo => { try { return value ? JSON.parse(value) as MountInfo : {}; } catch { throw new ProjectMountError('Could not read the project list from the service.'); } };
    if (process.argv[2] === '--orphan') process.stdout.write(orphanMount(input, process.argv[3] ?? '', info(process.argv[4])) ?? '');
    else if (process.argv[2] === '--check') checkExistingMounts(JSON.parse(input), process.argv[3] ?? '', process.argv[4] ?? '', info(process.argv[5]));
    else process.stdout.write(projectMount(input, process.argv[2] ?? '', process.argv[3] ?? '', info(process.argv[4])));
  }
  catch (error) { console.error(error instanceof ProjectMountError ? error.message : 'Could not read the project mount configuration. Check the Compose configuration and existing managed mounts.'); process.exitCode = 1; }
}
