/**
 * Zero-dependency Docker Engine API client over the host docker socket
 * (spec section 6c). The socket is bind-mounted into this container at
 * /var/run/docker.sock, so we speak plain HTTP over a UNIX socket with
 * node:http — no dockerode, no external deps.
 *
 * Container discovery matches umbrel's naming: first the exact container name
 * `${plexAppId}_server_1`, then a compose-label fallback
 * (com.docker.compose.project=<plexAppId> + service=server).
 */

import { request } from 'node:http';

import type { ContainerBind } from './types.js';

export interface DockerPlexInfo {
  found: boolean;
  containerName: string | null;
  state: string | null;
  binds: ContainerBind[];
  /** Container State.StartedAt (ISO), for the bind-generation recreate rule (spec section 5). */
  startedAt: string | null;
}

interface RawResponse {
  status: number;
  body: string;
}

interface InspectJson {
  Name?: string;
  Id?: string;
  State?: { Running?: boolean; Status?: string; StartedAt?: string };
  Mounts?: Array<{ Source?: string; Destination?: string }>;
}

interface ListJson {
  Id?: string;
  Names?: string[];
}

export class DockerApi {
  constructor(private readonly socketPath: string = '/var/run/docker.sock') {}

  private req(method: string, path: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const r = request(
        { socketPath: this.socketPath, path, method, headers: { Host: 'localhost' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      r.on('error', reject);
      r.end();
    });
  }

  private mapInspect(json: InspectJson): DockerPlexInfo {
    const name = (json.Name ?? '').replace(/^\//, '');
    const state = json.State?.Status ?? (json.State?.Running ? 'running' : null);
    const startedAt = typeof json.State?.StartedAt === 'string' ? json.State.StartedAt : null;
    const binds: ContainerBind[] = (json.Mounts ?? [])
      .filter((m) => typeof m.Source === 'string' && typeof m.Destination === 'string')
      .map((m) => ({ source: m.Source as string, destination: m.Destination as string }));
    return { found: true, containerName: name || null, state, binds, startedAt };
  }

  /** Find the Plex `server` container by exact name, then by compose labels. */
  async findPlexContainer(plexAppId: string): Promise<DockerPlexInfo> {
    const notFound: DockerPlexInfo = {
      found: false,
      containerName: null,
      state: null,
      binds: [],
      startedAt: null,
    };

    // 1. Exact container name.
    try {
      const byName = await this.req('GET', `/containers/${plexAppId}_server_1/json`);
      if (byName.status === 200) {
        return this.mapInspect(JSON.parse(byName.body) as InspectJson);
      }
    } catch {
      /* fall through to the label filter */
    }

    // 2. Compose-label fallback.
    try {
      const filters = encodeURIComponent(
        JSON.stringify({
          label: [
            `com.docker.compose.project=${plexAppId}`,
            'com.docker.compose.service=server',
          ],
        }),
      );
      const list = await this.req('GET', `/containers/json?all=1&filters=${filters}`);
      if (list.status !== 200) return notFound;
      const arr = JSON.parse(list.body) as ListJson[];
      const first = arr[0];
      if (!first || typeof first.Id !== 'string') return notFound;
      const inspect = await this.req('GET', `/containers/${first.Id}/json`);
      if (inspect.status !== 200) return notFound;
      return this.mapInspect(JSON.parse(inspect.body) as InspectJson);
    } catch {
      return notFound;
    }
  }
}
