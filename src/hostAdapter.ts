/**
 * Host-interaction boundary (spec sections 4, 6, 7).
 *
 * ALL host access in status.ts / restore.ts / monitor.ts goes through the
 * HostAdapter interface — there is no direct fs/exec/socket use anywhere else.
 * That is what makes the whole system testable in-memory via mockAdapter.ts.
 *
 * The real adapter:
 *   - reads host files through /proc/1/root/<path> (PID 1's root),
 *   - reads the host mount table from /proc/1/mounts,
 *   - writes atomically (tmp file + rename) under /proc/1/root,
 *   - runs host commands via `nsenter -t 1 -m -u -i -n -- <argv...>` with argv
 *     ARRAYS only — settings values are never interpolated into a shell string,
 *     and env for the compose fallback is passed as `env VAR=val` argv tokens,
 *   - inspects Plex via the Docker socket (dockerApi.ts).
 */

import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';

import { DockerApi } from './dockerApi.js';
import type { ContainerBind } from './types.js';

export interface ExecOptions {
  env?: Record<string, string>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PlexInspect {
  found: boolean;
  containerName: string | null;
  state: string | null;
  binds: ContainerBind[];
}

export interface HostAdapter {
  /** Read a host file's UTF-8 contents, or null if it does not exist. */
  readFile(hostPath: string): Promise<string | null>;
  /** Atomically write a host file (tmp + rename); optional octal mode. */
  writeFileAtomic(hostPath: string, content: string, mode?: number): Promise<void>;
  /** True if the host path exists (following the final symlink's presence). */
  exists(hostPath: string): Promise<boolean>;
  /** Directory entries, or null if the path is missing / not a directory. */
  listDir(hostPath: string): Promise<string[] | null>;
  /** Canonical host path a symlink resolves to (e.g. by-uuid -> /dev/sdX), or null. */
  realpath(hostPath: string): Promise<string | null>;
  /** Raw text of the host mount table (/proc/1/mounts). */
  readProcMounts(): Promise<string>;
  /** Run a host command (argv array) via nsenter; never rejects on non-zero exit. */
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** The host's hostname (for DEVICE_HOSTNAME in the compose fallback). */
  hostname(): Promise<string>;
  /** Inspect the Plex container over the Docker socket. */
  inspectPlex(plexAppId: string): Promise<PlexInspect>;
}

const HOST_ROOT = '/proc/1/root';
const HOST_MOUNTS = '/proc/1/mounts';

/** Map a host-absolute path to its /proc/1/root view, rejecting traversal. */
function toHostView(hostPath: string): string {
  if (!hostPath.startsWith('/')) {
    throw new Error(`host path must be absolute: ${hostPath}`);
  }
  const norm = posix.normalize(hostPath);
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
    throw new Error(`unsafe host path: ${hostPath}`);
  }
  return posix.join(HOST_ROOT, norm);
}

export class RealHostAdapter implements HostAdapter {
  private readonly docker = new DockerApi();

  async readFile(hostPath: string): Promise<string | null> {
    try {
      return await readFile(toHostView(hostPath), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeFileAtomic(hostPath: string, content: string, mode?: number): Promise<void> {
    const full = toHostView(hostPath);
    const dir = posix.dirname(full);
    await mkdir(dir, { recursive: true });
    const tmp = posix.join(dir, `.${posix.basename(full)}.drp-tmp-${process.pid}`);
    await writeFile(tmp, content, mode !== undefined ? { mode } : {});
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, full);
  }

  async exists(hostPath: string): Promise<boolean> {
    try {
      await lstat(toHostView(hostPath));
      return true;
    } catch {
      return false;
    }
  }

  async listDir(hostPath: string): Promise<string[] | null> {
    try {
      return await readdir(toHostView(hostPath));
    } catch {
      return null;
    }
  }

  async realpath(hostPath: string): Promise<string | null> {
    try {
      const resolved = await realpath(toHostView(hostPath));
      if (resolved.startsWith(HOST_ROOT)) {
        const stripped = resolved.slice(HOST_ROOT.length);
        return stripped === '' ? '/' : stripped;
      }
      return resolved;
    } catch {
      return null;
    }
  }

  async readProcMounts(): Promise<string> {
    try {
      return await readFile(HOST_MOUNTS, 'utf8');
    } catch {
      try {
        return await readFile('/proc/self/mounts', 'utf8');
      } catch {
        return '';
      }
    }
  }

  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
    const nsArgs: string[] = ['-t', '1', '-m', '-u', '-i', '-n', '--'];
    if (opts?.env) {
      nsArgs.push('env');
      for (const [key, value] of Object.entries(opts.env)) {
        nsArgs.push(`${key}=${value}`);
      }
    }
    nsArgs.push(...argv);

    return new Promise<ExecResult>((resolve) => {
      execFile(
        'nsenter',
        nsArgs,
        { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
        (err, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
          const errOut = typeof stderr === 'string' ? stderr : String(stderr ?? '');
          if (err) {
            const raw = (err as NodeJS.ErrnoException).code;
            const code = typeof raw === 'number' ? raw : raw === 'ENOENT' ? 127 : 1;
            resolve({ code, stdout: out, stderr: errOut || err.message });
          } else {
            resolve({ code: 0, stdout: out, stderr: errOut });
          }
        },
      );
    });
  }

  async hostname(): Promise<string> {
    const fromFile = await this.readFile('/etc/hostname');
    if (fromFile && fromFile.trim() !== '') return fromFile.trim();
    const result = await this.exec(['hostname']);
    const name = result.stdout.trim();
    return name !== '' ? name : 'umbrel';
  }

  inspectPlex(plexAppId: string): Promise<PlexInspect> {
    return this.docker.findPlexContainer(plexAppId);
  }
}

export function createRealAdapter(): HostAdapter {
  return new RealHostAdapter();
}
