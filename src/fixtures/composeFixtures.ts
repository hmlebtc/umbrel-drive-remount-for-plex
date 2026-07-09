// Fixtures for composePatch.test.ts.
//
// These emulate the Plex app's *installed* docker-compose.yml as umbreld
// actually produces/reserializes it (spec section 6(b) / section 12):
//  - umbreld's patchComposeFile() force-injects `container_name: plex_server_1`
//    on every install/update/start.
//  - Plex uses `network_mode: host`, references ${DEVICE_HOSTNAME},
//    ${APP_DATA_DIR}, ${UMBREL_ROOT}, and has no app_proxy.
//  - A YAML round-trip through umbreld can reformat indentation/quoting
//    without touching semantics — composePatch must tolerate that.

export const HOST_MEDIA_PATH = "/mnt/wdexternal/media";
export const CONTAINER_MEDIA_PATH = "/media/wdexternal";
export const TARGET_VOLUME_LINE = HOST_MEDIA_PATH + ":" + CONTAINER_MEDIA_PATH;

// "As freshly installed" shape: 2-space indentation, unquoted scalars/list items.
export const PLEX_COMPOSE_BASIC = `version: "3.7"

services:
  server:
    image: umbrel/plex:1.32.8
    container_name: plex_server_1
    network_mode: host
    hostname: \${DEVICE_HOSTNAME}
    restart: on-failure
    volumes:
      - \${APP_DATA_DIR}/data/config:/config
      - \${APP_DATA_DIR}/data/transcode:/transcode
      - \${UMBREL_ROOT}/home/Downloads:/downloads
    environment:
      TZ: UTC
    labels:
      - "com.centurylinklabs.watchtower.enable=false"
`;

// "umbreld-reserialized" shape: different (3-space) indentation and quoted
// scalars/list items, key order shuffled (version moved to the bottom) —
// still semantically identical, must be handled the same way.
export const PLEX_COMPOSE_RESERIALIZED = `services:
   server:
      image: "umbrel/plex:1.32.8"
      container_name: "plex_server_1"
      network_mode: "host"
      hostname: "\${DEVICE_HOSTNAME}"
      restart: "on-failure"
      volumes:
         - "\${APP_DATA_DIR}/data/config:/config"
         - "\${APP_DATA_DIR}/data/transcode:/transcode"
         - "\${UMBREL_ROOT}/home/Downloads:/downloads"
      environment:
         TZ: "UTC"
version: "3.7"
`;

// Already patched (basic shape), unquoted target line already present as the
// last volume item.
export const PLEX_COMPOSE_BASIC_ALREADY_PATCHED = `version: "3.7"

services:
  server:
    image: umbrel/plex:1.32.8
    container_name: plex_server_1
    network_mode: host
    hostname: \${DEVICE_HOSTNAME}
    restart: on-failure
    volumes:
      - \${APP_DATA_DIR}/data/config:/config
      - \${APP_DATA_DIR}/data/transcode:/transcode
      - \${UMBREL_ROOT}/home/Downloads:/downloads
      - ${HOST_MEDIA_PATH}:${CONTAINER_MEDIA_PATH}
    environment:
      TZ: UTC
`;

// Already patched (reserialized shape), QUOTED target line already present.
export const PLEX_COMPOSE_RESERIALIZED_ALREADY_PATCHED = `services:
   server:
      image: "umbrel/plex:1.32.8"
      container_name: "plex_server_1"
      network_mode: "host"
      hostname: "\${DEVICE_HOSTNAME}"
      restart: "on-failure"
      volumes:
         - "\${APP_DATA_DIR}/data/config:/config"
         - "\${APP_DATA_DIR}/data/transcode:/transcode"
         - "\${UMBREL_ROOT}/home/Downloads:/downloads"
         - "${HOST_MEDIA_PATH}:${CONTAINER_MEDIA_PATH}"
      environment:
         TZ: "UTC"
version: "3.7"
`;

// server: service present, but no volumes: key underneath it at all.
export const PLEX_COMPOSE_NO_VOLUMES_KEY = `services:
  server:
    image: umbrel/plex:1.32.8
    container_name: plex_server_1
    network_mode: host
    hostname: \${DEVICE_HOSTNAME}
    restart: on-failure
`;

// No "server:" service at all (e.g. wrong app / unexpected compose shape).
export const PLEX_COMPOSE_NO_SERVER_SERVICE = `version: "3.7"

services:
  web:
    image: umbrel/some-other-app:1.0.0
    container_name: some_other_app_web_1
    volumes:
      - \${APP_DATA_DIR}/data:/data
`;

// ---------------------------------------------------------------------------
// Corruption/idempotence regression fixtures (composePatch scanner rework).
// ---------------------------------------------------------------------------

// (a) A trailing #-comment on the `volumes:` key with block children below.
// This is BLOCK style, NOT an inline flow array — the `volumes:` line must
// never be rewritten into `volumes: [# bind mounts, ...]`.
export const PLEX_COMPOSE_TRAILING_COMMENT_VOLUMES = `version: "3.7"

services:
  server:
    image: umbrel/plex:1.32.8
    container_name: plex_server_1
    network_mode: host
    volumes:  # bind mounts
      - \${APP_DATA_DIR}/data/config:/config
      - \${UMBREL_ROOT}/home/Downloads:/downloads
    environment:
      TZ: UTC
`;

// (b) CRLF line endings, ALREADY patched. Idempotence must hold byte-for-byte:
// no duplicate insertion, no mixed EOL.
export const PLEX_COMPOSE_CRLF_ALREADY_PATCHED =
  'version: "3.7"\r\n' +
  '\r\n' +
  'services:\r\n' +
  '  server:\r\n' +
  '    image: umbrel/plex:1.32.8\r\n' +
  '    container_name: plex_server_1\r\n' +
  '    volumes:\r\n' +
  '      - ${APP_DATA_DIR}/data/config:/config\r\n' +
  '      - ' + HOST_MEDIA_PATH + ':' + CONTAINER_MEDIA_PATH + '\r\n' +
  '      - ${UMBREL_ROOT}/home/Downloads:/downloads\r\n' +
  '    environment:\r\n' +
  '      TZ: UTC\r\n';

// (b2) CRLF, NOT yet patched — the insert must use CRLF and be idempotent.
export const PLEX_COMPOSE_CRLF_BASIC =
  'version: "3.7"\r\n' +
  '\r\n' +
  'services:\r\n' +
  '  server:\r\n' +
  '    image: umbrel/plex:1.32.8\r\n' +
  '    container_name: plex_server_1\r\n' +
  '    volumes:\r\n' +
  '      - ${APP_DATA_DIR}/data/config:/config\r\n' +
  '      - ${UMBREL_ROOT}/home/Downloads:/downloads\r\n' +
  '    environment:\r\n' +
  '      TZ: UTC\r\n';

// (c) Blank + comment-only lines interleaved between volume items, with the
// target already present AFTER a comment. Collection must skip the blank/comment
// and still see the target -> already-present, no duplicate insertion.
export const PLEX_COMPOSE_COMMENT_INTERLEAVED_ALREADY_PATCHED = `version: "3.7"

services:
  server:
    image: umbrel/plex:1.32.8
    container_name: plex_server_1
    volumes:
      - \${APP_DATA_DIR}/data/config:/config

      # media library bind (managed by drive-remount-for-plex)
      - ${HOST_MEDIA_PATH}:${CONTAINER_MEDIA_PATH}
      - \${UMBREL_ROOT}/home/Downloads:/downloads
    environment:
      TZ: UTC
`;

// (c2) Same interleaving but NOT patched — a single clean insert after the LAST
// item, no duplicate.
export const PLEX_COMPOSE_COMMENT_INTERLEAVED_UNPATCHED = `version: "3.7"

services:
  server:
    image: umbrel/plex:1.32.8
    container_name: plex_server_1
    volumes:
      - \${APP_DATA_DIR}/data/config:/config

      # downloads bind
      - \${UMBREL_ROOT}/home/Downloads:/downloads
    environment:
      TZ: UTC
`;

// (d) Tab-indented compose. The patcher must EITHER cleanly insert OR return
// problems[] — it must never corrupt the file.
export const PLEX_COMPOSE_TABS =
  'version: "3.7"\n' +
  '\n' +
  'services:\n' +
  '\tserver:\n' +
  '\t\timage: umbrel/plex:1.32.8\n' +
  '\t\tcontainer_name: plex_server_1\n' +
  '\t\tvolumes:\n' +
  '\t\t\t- ${APP_DATA_DIR}/data/config:/config\n' +
  '\t\t\t- ${UMBREL_ROOT}/home/Downloads:/downloads\n' +
  '\t\tenvironment:\n' +
  '\t\t\tTZ: UTC\n';
