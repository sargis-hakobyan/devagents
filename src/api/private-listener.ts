import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AppError } from '../domain/errors.js';

/** The operator mounts this directory into only the gateway and this owner's container. */
export async function listenPrivate(server: Server, directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new AppError('invalid_socket', 'Expected an absolute private socket directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new AppError('invalid_socket', 'The runtime must own its private socket directory');
  await chmod(directory, 0o700);
  const socket = join(directory, 'api.sock');
  const old = await lstat(socket).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (old) {
    if (!old.isSocket() || old.uid !== info.uid) throw new AppError('invalid_socket', 'Unexpected file at the private socket path');
    // Only remove a dead socket. The caller holds the exclusive workspace data lock.
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socket);
      probe.once('connect', () => { probe.destroy(); reject(new AppError('socket_in_use', 'Workspace socket is already in use')); });
      probe.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
    });
    await unlink(socket);
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600);
}
