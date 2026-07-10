// Self-contained single-page dashboard for the Drive Remount for Plex daemon.
//
// One HTML document (inline CSS + vanilla JS, no build step, no external assets,
// fonts, or CDNs — the Umbrel node may be offline) served by server.ts at `/`.
// It consumes ONLY the JSON API in spec section 9 (envelope {ok:true,data} |
// {ok:false,error} on every /api/* route): /api/status, /api/restore,
// /api/restart-plex, /api/job, /api/events, /api/settings, /api/auto-heal,
// /api/reset-failures, /api/check.
//
// Template-literal safety: DASHBOARD_HTML is a String.raw literal, so backslash
// escapes inside the embedded JS/CSS are preserved verbatim. There are NO
// backtick characters and NO "${" sequences anywhere inside the literal — the
// embedded JavaScript uses only quoted strings and string concatenation.

export const FAVICON_SVG: string =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Drive Remount for Plex">' +
  '<defs><linearGradient id="drpFav" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#f2b53d"/><stop offset="1" stop-color="#e5a00d"/></linearGradient></defs>' +
  '<rect width="512" height="512" rx="112" fill="url(#drpFav)"/>' +
  '<rect x="84" y="152" width="344" height="176" rx="26" fill="#ffffff"/>' +
  '<rect x="116" y="256" width="280" height="16" rx="8" fill="#c7cdd6"/>' +
  '<circle cx="146" cy="296" r="12" fill="#94a3b8"/>' +
  '<circle cx="182" cy="296" r="12" fill="#94a3b8"/>' +
  '<circle cx="356" cy="366" r="58" fill="#171f2e"/>' +
  '<path d="M338 342 L338 390 L380 366 Z" fill="#e5a00d"/>' +
  '</svg>';

export const DASHBOARD_HTML: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Drive Remount for Plex</title>
<link rel="icon" href="/favicon.svg">
<style>
  :root {
    color-scheme: dark;
    --bg: #0e1420;
    --bg2: #0b111c;
    --card: #171f2e;
    --card2: #1c2536;
    --border: #2a3648;
    --border2: #37485f;
    --text: #e7eef7;
    --muted: #93a1b5;
    --faint: #647389;
    --input: #101a2b;
    --amber: #e5a00d;
    --amber-soft: rgba(229,160,13,0.13);
    --amber-line: rgba(229,160,13,0.55);
    --blue: #3b82f6;
    --blue2: #4f8cff;
    --green: #34d399;
    --green-soft: rgba(52,211,153,0.16);
    --red: #f87171;
    --red-soft: rgba(248,113,113,0.15);
    --yellow: #facc15;
    --yellow-soft: rgba(250,204,21,0.16);
    --gray: #94a3b8;
    --gray-soft: rgba(148,163,184,0.16);
    --blue-soft: rgba(59,130,246,0.16);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%) fixed;
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  a { color: var(--blue2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .grow { flex: 1 1 auto; }
  .small { font-size: 12px; }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .ok { color: var(--green); }
  .err { color: var(--red); }
  .warn-t { color: var(--yellow); }
  .accent { color: var(--amber); }
  .accent-num { color: var(--amber); }

  header {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 12px;
    padding: 12px 20px;
    background: rgba(11,17,28,0.86);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .brand-icon svg { width: 34px; height: 34px; display: block; border-radius: 9px; }
  .brand { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
  .ver { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .conn-note { color: var(--yellow); font-size: 12px; }

  .pill { padding: 5px 12px; border-radius: 999px; font-weight: 600; font-size: 12px; white-space: nowrap; border: 1px solid transparent; }
  .pill-ok { background: var(--green-soft); color: var(--green); border-color: rgba(52,211,153,0.35); }
  .pill-warn { background: var(--yellow-soft); color: var(--yellow); border-color: rgba(250,204,21,0.35); }
  .pill-down { background: var(--red-soft); color: var(--red); border-color: rgba(248,113,113,0.4); }
  .pill-job { background: var(--blue-soft); color: #7aa7ff; border-color: rgba(59,130,246,0.4); }

  .btn {
    font: inherit; font-weight: 600; font-size: 14px;
    padding: 8px 14px; border-radius: 9px;
    border: 1px solid var(--border2); background: var(--card2); color: var(--text);
    cursor: pointer; transition: border-color .15s, background .15s, transform .05s, opacity .15s;
    white-space: nowrap;
  }
  .btn:hover { border-color: var(--blue2); }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn:focus-visible { outline: 2px solid var(--blue2); outline-offset: 2px; }
  .btn-sm { padding: 6px 11px; font-size: 13px; }
  .btn.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
  .btn.primary:hover { background: #4f8cff; border-color: #4f8cff; }
  .btn.amber { background: var(--amber); border-color: var(--amber); color: #1a1200; }
  .btn.amber:hover { background: #f2b53d; border-color: #f2b53d; }
  .btn.danger { background: var(--red); border-color: var(--red); color: #2a0a0a; }
  .btn.danger:hover { background: #fb9c9c; border-color: #fb9c9c; }

  main { max-width: 940px; margin: 0 auto; padding: 20px 16px 40px; width: 100%; }

  .banner {
    display: flex; gap: 14px; align-items: flex-start;
    background: linear-gradient(180deg, rgba(248,113,113,0.16), rgba(248,113,113,0.05));
    border: 1px solid rgba(248,113,113,0.5);
    border-left: 4px solid var(--red);
    border-radius: 12px; padding: 16px 18px; margin-bottom: 18px;
  }
  .banner-ic { font-size: 26px; line-height: 1; }
  .banner-body strong { display: block; margin-bottom: 4px; font-size: 15px; }
  .banner-body p { margin: 0 0 10px; color: var(--muted); font-size: 13.5px; }
  .banner-body p:last-child { margin-bottom: 0; }

  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 14px; padding: 18px; margin-bottom: 18px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.25);
  }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .card-head h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0; font-weight: 700; }
  .card-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
  .hint { margin-left: auto; font-size: 12px; color: var(--faint); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile { background: var(--card2); border: 1px solid var(--border); border-radius: 11px; padding: 12px 14px; min-width: 0; }
  .tile-l { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin-bottom: 7px; font-weight: 600; }
  .tile-v { font-size: 14px; font-weight: 600; word-break: break-word; }
  .tile-sub { font-size: 12px; color: var(--muted); margin-top: 4px; word-break: break-word; }
  .tile-sub div { margin-top: 3px; }
  .tile-sub .warn-t { font-weight: 600; }

  .tpill { display: inline-block; padding: 2px 9px; border-radius: 7px; font-size: 11px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; white-space: nowrap; }
  .tpill-ok { background: var(--green-soft); color: var(--green); }
  .tpill-broken { background: var(--red-soft); color: var(--red); }
  .tpill-unknown { background: var(--gray-soft); color: var(--gray); }

  .chip { display: inline-block; padding: 2px 9px; border-radius: 7px; font-size: 11.5px; font-weight: 700; letter-spacing: .02em; }
  .chip-info { background: var(--blue-soft); color: #7aa7ff; }
  .chip-ok { background: var(--green-soft); color: var(--green); }
  .chip-warn { background: var(--yellow-soft); color: var(--yellow); }
  .chip-error { background: var(--red-soft); color: var(--red); }

  .actions-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .autoheal-toggle { display: flex; align-items: center; gap: 9px; font-size: 13.5px; font-weight: 600; margin-left: auto; }
  .autoheal-toggle input { width: 17px; height: 17px; accent-color: var(--amber); cursor: pointer; }
  .last-restore { width: 100%; font-size: 12.5px; color: var(--faint); margin-top: 2px; }

  .steps { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .step { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; background: var(--card2); border: 1px solid var(--border); font-size: 13.5px; }
  .step-ic { width: 20px; height: 20px; border-radius: 999px; flex: none; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; }
  .step-pending .step-ic { background: var(--gray-soft); color: var(--gray); }
  .step-running .step-ic { background: var(--blue-soft); color: #7aa7ff; }
  .step-ok .step-ic { background: var(--green-soft); color: var(--green); }
  .step-failed .step-ic { background: var(--red-soft); color: var(--red); }
  .step-skipped .step-ic { background: var(--gray-soft); color: var(--faint); }
  .step-label { flex: 1; min-width: 0; }
  .step-skipped .step-label { color: var(--faint); font-style: italic; }
  .step-state-txt { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--faint); font-weight: 700; }

  .joblog { background: var(--input); border: 1px solid var(--border2); border-radius: 9px; padding: 10px 12px; max-height: 240px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .joblog:empty::before { content: "no output yet"; color: var(--faint); font-style: italic; }

  .log { list-style: none; margin: 0; padding: 0; }
  .log-item { display: flex; gap: 12px; padding: 11px 2px; border-bottom: 1px solid var(--border); }
  .log-item:last-child { border-bottom: none; }
  .log-main { min-width: 0; flex: 1; }
  .log-title { font-weight: 600; font-size: 14px; word-break: break-word; }
  .log-sub { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
  .log-body { font-size: 12px; color: var(--faint); margin-top: 5px; white-space: pre-line; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .chip { align-self: flex-start; }

  .empty { text-align: center; color: var(--faint); font-size: 13.5px; padding: 22px 10px; }
  .problems { margin: 3px 0 0; padding-left: 16px; }
  .problems li { color: var(--yellow); }

  form fieldset { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px 16px; margin: 0 0 16px; }
  form legend { padding: 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--amber); font-weight: 700; }
  .field { margin-bottom: 12px; display: flex; flex-direction: column; gap: 5px; }
  .field:last-child { margin-bottom: 0; }
  .field-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; margin-bottom: 12px; }
  .field-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px 14px; margin-bottom: 12px; }
  .field label, .field > label { font-size: 13px; font-weight: 600; color: var(--text); }
  .lbl-note { font-weight: 400; color: var(--faint); font-size: 12px; }
  input[type=text], input[type=number] {
    font: inherit; font-size: 14px; width: 100%;
    padding: 8px 11px; border-radius: 9px;
    background: var(--input); border: 1px solid var(--border2); color: var(--text);
  }
  input:focus { outline: none; border-color: var(--blue2); box-shadow: 0 0 0 3px rgba(59,130,246,0.18); }
  .check { display: flex; align-items: flex-start; gap: 9px; margin: 9px 0 0; font-size: 13.5px; cursor: pointer; color: var(--text); }
  .check input { width: 17px; height: 17px; margin-top: 1px; accent-color: var(--amber); flex: none; }
  .form-foot { display: flex; justify-content: flex-end; margin-top: 4px; }
  .errbox { background: var(--red-soft); border: 1px solid rgba(248,113,113,0.5); border-radius: 10px; padding: 11px 14px; margin-bottom: 14px; color: #fecaca; font-size: 13.5px; }
  .field-err { font-size: 12px; color: var(--red); margin-top: 2px; min-height: 0; }

  footer { max-width: 940px; margin: 0 auto; padding: 8px 16px 30px; color: var(--faint); font-size: 12px; text-align: center; }

  .toasts { position: fixed; right: 16px; bottom: 16px; z-index: 60; display: flex; flex-direction: column; gap: 8px; max-width: min(360px, calc(100vw - 32px)); }
  .toast {
    padding: 11px 14px; border-radius: 10px; font-size: 13.5px; font-weight: 500;
    background: var(--card2); border: 1px solid var(--border2); color: var(--text);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    opacity: 0; transform: translateY(8px); transition: opacity .22s ease, transform .22s ease;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast-ok { border-color: rgba(52,211,153,0.6); }
  .toast-ok::before { content: "\2713  "; color: var(--green); font-weight: 700; }
  .toast-error { border-color: rgba(248,113,113,0.6); }
  .toast-error::before { content: "\26A0  "; color: var(--red); }
  .toast-info::before { content: "\2139  "; color: var(--blue2); }

  @media (max-width: 520px) {
    main { padding: 16px 12px 36px; }
    .card { padding: 15px; }
    .field-2, .field-3 { grid-template-columns: 1fr; }
    .autoheal-toggle { margin-left: 0; }
    .toasts { left: 12px; right: 12px; max-width: none; }
  }
</style>
</head>
<body>
<header>
  <span class="brand-icon" aria-hidden="true">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <defs><linearGradient id="drpHdr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2b53d"/><stop offset="1" stop-color="#e5a00d"/></linearGradient></defs>
      <rect width="512" height="512" rx="112" fill="url(#drpHdr)"/>
      <rect x="84" y="152" width="344" height="176" rx="26" fill="#ffffff"/>
      <rect x="116" y="256" width="280" height="16" rx="8" fill="#c7cdd6"/>
      <circle cx="146" cy="296" r="12" fill="#94a3b8"/>
      <circle cx="182" cy="296" r="12" fill="#94a3b8"/>
      <circle cx="356" cy="366" r="58" fill="#171f2e"/>
      <path d="M338 342 L338 390 L380 366 Z" fill="#e5a00d"/>
    </svg>
  </span>
  <div class="brand">
    <h1>Drive Remount for Plex</h1>
    <span class="ver" id="appVersion" title=""></span>
  </div>
  <span class="grow"></span>
  <span class="conn-note" id="connNote" style="display:none">reconnecting&hellip;</span>
  <span class="pill pill-job" id="jobBadge" style="display:none">Job running</span>
  <span class="pill pill-ok" id="statusPill">&hellip;</span>
</header>

<main>
  <section class="banner" id="suspendedBanner" style="display:none" role="alert">
    <div class="banner-ic" aria-hidden="true">&#9888;&#65039;</div>
    <div class="banner-body">
      <strong>Auto-heal suspended after repeated failures.</strong>
      <p id="suspendedDetail">The daemon stopped retrying automatically so it does not loop on a failing fix. Investigate the tiles below, then reset failures to let auto-heal resume, or run a full restore manually.</p>
      <button class="btn btn-sm danger" id="resetFailuresBtn" type="button">Reset failures</button>
    </div>
  </section>

  <section class="card" id="statusCard">
    <div class="card-head">
      <h2>Status</h2>
      <span class="hint" id="lastCheckHint">&mdash;</span>
    </div>
    <div class="tiles">
      <div class="tile">
        <div class="tile-l"><span>Drive</span><span class="tpill tpill-unknown" id="tp_drive">&mdash;</span></div>
        <div class="tile-v" id="tv_drive">&mdash;</div>
        <div class="tile-sub" id="ts_drive"></div>
      </div>
      <div class="tile">
        <div class="tile-l"><span>Mount</span><span class="tpill tpill-unknown" id="tp_mount">&mdash;</span></div>
        <div class="tile-v" id="tv_mount">&mdash;</div>
        <div class="tile-sub" id="ts_mount"></div>
      </div>
      <div class="tile">
        <div class="tile-l"><span>Boot hook</span><span class="tpill tpill-unknown" id="tp_bootHook">&mdash;</span></div>
        <div class="tile-v" id="tv_bootHook">&mdash;</div>
        <div class="tile-sub" id="ts_bootHook"></div>
      </div>
      <div class="tile">
        <div class="tile-l"><span>Compose patch</span><span class="tpill tpill-unknown" id="tp_composePatch">&mdash;</span></div>
        <div class="tile-v" id="tv_composePatch">&mdash;</div>
        <div class="tile-sub" id="ts_composePatch"></div>
      </div>
      <div class="tile">
        <div class="tile-l"><span>Plex bind</span><span class="tpill tpill-unknown" id="tp_plex">&mdash;</span></div>
        <div class="tile-v" id="tv_plex">&mdash;</div>
        <div class="tile-sub" id="ts_plex"></div>
      </div>
      <div class="tile">
        <div class="tile-l"><span>Media folders</span><span class="tpill tpill-unknown" id="tp_media">&mdash;</span></div>
        <div class="tile-v" id="tv_media">&mdash;</div>
        <div class="tile-sub" id="ts_media"></div>
      </div>
    </div>
  </section>

  <section class="card" id="actionsCard">
    <div class="card-head"><h2>Actions</h2></div>
    <div class="actions-row">
      <button class="btn btn-sm danger" id="restoreBtn" type="button">Run full restore</button>
      <button class="btn btn-sm" id="restartPlexBtn" type="button">Restart Plex</button>
      <button class="btn btn-sm" id="checkNowBtn" type="button">Check now</button>
      <button class="btn btn-sm" id="removeLegacyOverrideBtn" type="button" style="display:none">Remove legacy override</button>
      <label class="autoheal-toggle" for="autoHealToggle"><input id="autoHealToggle" type="checkbox"><span>Auto-heal</span></label>
      <div class="last-restore" id="lastRestoreLine"></div>
    </div>
  </section>

  <section class="card" id="jobCard" style="display:none">
    <div class="card-head"><h2>Job</h2><span class="hint" id="jobKind">&mdash;</span></div>
    <ul class="steps" id="jobSteps"></ul>
    <div class="joblog" id="jobLog"></div>
  </section>

  <section class="card" id="eventsCard">
    <div class="card-head"><h2>Activity history</h2></div>
    <ul class="log" id="eventsList"></ul>
    <div class="empty" id="eventsEmpty" style="display:none">No activity recorded yet.</div>
  </section>

  <section class="card" id="settingsCard">
    <div class="card-head"><h2>Settings</h2></div>
    <div class="errbox" id="settingsErrors" style="display:none" role="alert"></div>
    <form id="settingsForm" novalidate>
      <fieldset>
        <legend>Drive &amp; filesystem</legend>
        <div class="field-2">
          <div class="field">
            <label for="cfg_uuid">Drive UUID</label>
            <input id="cfg_uuid" type="text" placeholder="555bf6f0-ae17-4137-adec-e91818854f1c" autocomplete="off" spellcheck="false">
            <div class="field-err" id="err_uuid"></div>
          </div>
          <div class="field">
            <label for="cfg_fsType">Filesystem type</label>
            <input id="cfg_fsType" type="text" placeholder="ext4" autocomplete="off" spellcheck="false">
            <div class="field-err" id="err_fsType"></div>
          </div>
        </div>
        <div class="field">
          <label for="cfg_mountPoint">Mount point <span class="lbl-note">(absolute path)</span></label>
          <input id="cfg_mountPoint" type="text" placeholder="/mnt/wdexternal" autocomplete="off" spellcheck="false">
          <div class="field-err" id="err_mountPoint"></div>
        </div>
        <div class="field-2">
          <div class="field">
            <label for="cfg_mediaSubdir">Media subdirectory</label>
            <input id="cfg_mediaSubdir" type="text" placeholder="media" autocomplete="off" spellcheck="false">
            <div class="field-err" id="err_mediaSubdir"></div>
          </div>
          <div class="field">
            <label for="cfg_folders">Media folders <span class="lbl-note">(comma-separated)</span></label>
            <input id="cfg_folders" type="text" placeholder="Movies, TVshows, Music" autocomplete="off" spellcheck="false">
            <div class="field-err" id="err_folders"></div>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Plex &amp; umbrelOS</legend>
        <div class="field-2">
          <div class="field">
            <label for="cfg_plexAppId">Plex app id</label>
            <input id="cfg_plexAppId" type="text" placeholder="plex" autocomplete="off" spellcheck="false">
            <div class="field-err" id="err_plexAppId"></div>
          </div>
          <div class="field">
            <label for="cfg_umbrelRoot">umbrelOS root <span class="lbl-note">(absolute path)</span></label>
            <input id="cfg_umbrelRoot" type="text" placeholder="/home/umbrel/umbrel" autocomplete="off" spellcheck="false">
            <div class="field-err" id="err_umbrelRoot"></div>
          </div>
        </div>
        <div class="field">
          <label for="cfg_containerMediaPath">Container media path <span class="lbl-note">(absolute path, inside the Plex container)</span></label>
          <input id="cfg_containerMediaPath" type="text" placeholder="/media/wdexternal" autocomplete="off" spellcheck="false">
          <div class="field-err" id="err_containerMediaPath"></div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Auto-heal</legend>
        <label class="check"><input id="cfg_autoHealEnabled" type="checkbox"><span>Automatically run a full restore after repeated check failures</span></label>
        <div class="field-2" style="margin-top:12px">
          <div class="field">
            <label for="cfg_intervalSec">Check interval <span class="lbl-note">(seconds, 10&ndash;3600)</span></label>
            <input id="cfg_intervalSec" type="number" min="10" max="3600" step="1" inputmode="numeric">
            <div class="field-err" id="err_intervalSec"></div>
          </div>
          <div class="field">
            <label for="cfg_cooldownSec">Cooldown between restores <span class="lbl-note">(seconds, 60&ndash;86400)</span></label>
            <input id="cfg_cooldownSec" type="number" min="60" max="86400" step="1" inputmode="numeric">
            <div class="field-err" id="err_cooldownSec"></div>
          </div>
        </div>
        <div class="field-2">
          <div class="field">
            <label for="cfg_maxConsecutiveFailures">Max consecutive failures <span class="lbl-note">(before suspend)</span></label>
            <input id="cfg_maxConsecutiveFailures" type="number" min="1" step="1" inputmode="numeric">
            <div class="field-err" id="err_maxConsecutiveFailures"></div>
          </div>
          <div class="field">
            <label for="cfg_requireConsecutiveBroken">Debounce <span class="lbl-note">(consecutive broken checks before acting)</span></label>
            <input id="cfg_requireConsecutiveBroken" type="number" min="1" step="1" inputmode="numeric">
            <div class="field-err" id="err_requireConsecutiveBroken"></div>
          </div>
        </div>
      </fieldset>

      <div class="form-foot"><button class="btn amber" id="saveBtn" type="submit">Save settings</button></div>
    </form>
  </section>
</main>

<footer><span id="footVersion">Drive Remount for Plex</span></footer>

<div class="toasts" id="toasts" aria-live="polite" aria-atomic="false"></div>

<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; }); }

  function setText(id, t) { var e = $(id); if (e) e.textContent = t; }
  function setHtml(id, h) { var e = $(id); if (e) e.innerHTML = h; }
  function setV(id, v) { var e = $(id); if (e) e.value = (v == null ? "" : String(v)); }
  function setC(id, v) { var e = $(id); if (e) e.checked = !!v; }
  function val(id) { var e = $(id); return e ? e.value : ""; }
  function checked(id) { var e = $(id); return e ? !!e.checked : false; }
  function numVal(id, d) { var e = $(id); if (!e) return d; var n = parseInt(e.value, 10); return isNaN(n) ? d : n; }
  function show(id, on) { var e = $(id); if (e) e.style.display = on ? "" : "none"; }

  function fmtInt(n) {
    if (n == null || n === "") return "0";
    var num = Number(n);
    if (isNaN(num)) return String(n);
    try { return num.toLocaleString("en-US"); } catch (e) { return String(num); }
  }

  // ---- time helpers --------------------------------------------------------
  function toIso(v) {
    if (v == null || v === "") return "";
    if (typeof v === "number") { var d = new Date(v); return isNaN(d.getTime()) ? "" : d.toISOString(); }
    var t = Date.parse(v);
    return isNaN(t) ? "" : new Date(t).toISOString();
  }
  function relTime(iso, now) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "—";
    var s = Math.round(((now || Date.now()) - t) / 1000);
    if (s < 0) s = 0;
    if (s < 5) return "just now";
    if (s < 60) return s + " sec ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " hr ago";
    var d = Math.floor(h / 24);
    return d + " day" + (d === 1 ? "" : "s") + " ago";
  }
  function relSpan(v) {
    var iso = toIso(v);
    if (!iso) return '<span class="muted">—</span>';
    var abs = new Date(iso).toLocaleString();
    return '<span class="rel" data-ts="' + esc(iso) + '" title="' + esc(abs) + '">' + esc(relTime(iso)) + "</span>";
  }
  function refreshRelTimes() {
    var now = Date.now();
    var els = document.querySelectorAll("[data-ts]");
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = relTime(els[i].getAttribute("data-ts"), now);
    }
  }

  // ---- toasts --------------------------------------------------------------
  function toast(msg, kind) {
    var box = $("toasts");
    if (!box) return;
    var el = document.createElement("div");
    el.className = "toast toast-" + (kind || "info");
    el.setAttribute("role", "status");
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("show"); });
    setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 280);
    }, 4200);
  }

  // ---- API envelope helpers ({ok:true,data} | {ok:false,error}) ------------
  async function apiGet(url) {
    try {
      var r = await fetch(url, { cache: "no-store" });
      var j = await r.json();
      if (r.ok && j && j.ok) return { ok: true, data: j.data };
      return { ok: false, error: (j && j.error) ? j.error : ("HTTP " + r.status) };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  }
  async function apiPost(url, body) {
    try {
      var r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
      var j = await r.json();
      if (r.ok && j && j.ok) return { ok: true, data: j.data };
      return { ok: false, error: (j && j.error) ? j.error : ("HTTP " + r.status) };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  }
  async function apiPut(url, body) {
    try {
      var r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
      var j = await r.json();
      if (r.ok && j && j.ok) return { ok: true, data: j.data };
      return { ok: false, error: (j && j.error) ? j.error : ("HTTP " + r.status) };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  }

  // ---- busy helpers ----------------------------------------------------------
  function busy(btn, label) { var old = btn.textContent; btn.disabled = true; if (label) btn.textContent = label; return old; }
  function unbusy(btn, old) { btn.disabled = false; if (old != null) btn.textContent = old; }

  // ---- state ---------------------------------------------------------------
  var lastStatus = null;
  var jobPollTimer = null;
  var jobRunning = false;

  // ---- tiles: drive, mount, bootHook, composePatch, plex, media ------------
  var TILE_KEYS = ["drive", "mount", "bootHook", "composePatch", "plex", "media"];

  function tilePillClass(state) {
    if (state === "ok") return "tpill-ok";
    if (state === "broken") return "tpill-broken";
    return "tpill-unknown";
  }
  function tilePillLabel(state) {
    if (state === "ok") return "OK";
    if (state === "broken") return "Broken";
    return "Unknown";
  }

  // Derives an ok/broken/unknown tile state from the raw section-9 status
  // sub-object for the given tile key, per spec section 9's field shapes.
  function tileState(key, d) {
    if (!d) return "unknown";
    if (key === "drive") {
      if (d.present == null) return "unknown";
      return d.present ? "ok" : "broken";
    }
    if (key === "mount") {
      if (d.mounted == null) return "unknown";
      return (d.mounted && d.stale !== true) ? "ok" : "broken";
    }
    if (key === "bootHook" || key === "composePatch" || key === "media") {
      if (d.ok == null) return "unknown";
      return d.ok ? "ok" : "broken";
    }
    if (key === "plex") {
      if (d.found == null) return "unknown";
      if (!d.found) return "broken";
      return (d.bindOk && d.state === "running") ? "ok" : "broken";
    }
    return "unknown";
  }

  function problemsHtml(problems) {
    if (!problems || !problems.length) return "";
    var lis = "";
    for (var i = 0; i < problems.length; i++) lis += "<li>" + esc(problems[i]) + "</li>";
    return '<ul class="problems">' + lis + "</ul>";
  }

  function tileSubLines(key, d) {
    var lines = [];
    if (key === "drive") {
      if (d.device) lines.push('<span class="mono">' + esc(d.device) + "</span>");
      else lines.push('<span class="muted">no device path reported</span>');
    } else if (key === "mount") {
      if (!d.mounted) {
        lines.push('<span class="muted">not mounted</span>');
      } else {
        if (d.source) lines.push("source: " + '<span class="mono">' + esc(d.source) + "</span>");
        if (d.target) lines.push("target: " + '<span class="mono">' + esc(d.target) + "</span>");
        if (d.fsType) lines.push("fs: " + esc(d.fsType) + (d.rw === false ? " (read-only)" : ""));
        if (d.stale === true) lines.push('<span class="warn-t">stale mount</span>');
      }
    } else if (key === "bootHook") {
      if (d.path) lines.push('<span class="mono">' + esc(d.path) + "</span>");
      lines.push(problemsHtml(d.problems));
    } else if (key === "composePatch") {
      if (d.path) lines.push('<span class="mono">' + esc(d.path) + "</span>");
      if (d.legacyOverridePresent) lines.push('<span class="warn-t">legacy compose override present</span>');
      if (d.legacyFstabEntryPresent) lines.push('<span class="warn-t">legacy fstab entry present</span>');
      lines.push(problemsHtml(d.problems));
    } else if (key === "plex") {
      if (d.containerName) lines.push('<span class="mono">' + esc(d.containerName) + "</span>");
      if (d.state) lines.push("state: " + esc(d.state));
      if (d.found) lines.push(d.bindOk ? '<span class="ok small">bind present</span>' : '<span class="warn-t">bind missing</span>');
    } else if (key === "media") {
      var folders = d.folders || [];
      if (folders.length) {
        var parts = [];
        for (var i = 0; i < folders.length; i++) {
          var f = folders[i] || {};
          var label = esc(f.name || "?") + " (" + fmtInt(f.entries || 0) + ")";
          parts.push(f.present === false ? ('<span class="warn-t">' + label + " missing</span>") : label);
        }
        lines.push(parts.join(", "));
      }
    }
    return lines.filter(function (l) { return !!l; });
  }

  function renderTiles(s) {
    for (var i = 0; i < TILE_KEYS.length; i++) {
      var key = TILE_KEYS[i];
      var d = (s && s[key]) || {};
      var state = tileState(key, s ? s[key] : null);
      var pillEl = $("tp_" + key);
      if (pillEl) { pillEl.className = "tpill " + tilePillClass(state); pillEl.textContent = tilePillLabel(state); }
      setText("tv_" + key, tilePillLabel(state));
      var lines = tileSubLines(key, d);
      setHtml("ts_" + key, lines.length ? lines.join("<br>") : '<span class="muted">no detail reported</span>');
    }
  }

  function overallDegraded(s) {
    for (var i = 0; i < TILE_KEYS.length; i++) {
      if (tileState(TILE_KEYS[i], s[TILE_KEYS[i]]) === "broken") return true;
    }
    return false;
  }

  // ---- status render ---------------------------------------------------------
  function renderStatus(s) {
    lastStatus = s;
    setText("appVersion", s.version ? ("v" + s.version) : "");
    var vEl = $("appVersion"); if (vEl) vEl.title = s.gitSha ? ("build " + s.gitSha) : "";
    setText("footVersion", "Drive Remount for Plex" + (s.version ? (" v" + s.version) : "") + (s.gitSha ? (" · " + s.gitSha) : ""));

    var ah = s.autoHeal || {};
    var suspended = !!ah.suspended;

    var pill = $("statusPill");
    if (pill) {
      if (suspended) { pill.textContent = "Suspended"; pill.className = "pill pill-down"; }
      else if (overallDegraded(s)) { pill.textContent = "Degraded"; pill.className = "pill pill-warn"; }
      else { pill.textContent = "Healthy"; pill.className = "pill pill-ok"; }
    }

    show("suspendedBanner", suspended);
    if (suspended) {
      var cf = ah.consecutiveFailures != null ? ah.consecutiveFailures : "several";
      setText("suspendedDetail", "The daemon stopped retrying automatically after " + cf + " consecutive failures, so it does not loop on a failing fix. Investigate the tiles below, then reset failures to let auto-heal resume, or run a full restore manually.");
    }

    var lcHtml = ah.lastCheckAt ? relSpan(ah.lastCheckAt) : "never";
    setHtml("lastCheckHint", "last check " + lcHtml);

    setC("autoHealToggle", !!ah.enabled);

    var cp = s.composePatch || {};
    show("removeLegacyOverrideBtn", cp.legacyOverridePresent === true);

    var lr = s.lastRestore;
    var lrAt = lr && (lr.at || lr.finishedAt || lr.startedAt);
    if (lr && lrAt) {
      setHtml("lastRestoreLine", "last restore " + relSpan(lrAt) + " · " + esc(lr.trigger || "manual") + " · " + esc(String(lr.result != null ? lr.result : "")));
    } else {
      setText("lastRestoreLine", "no restore has run yet");
    }

    renderTiles(s);
  }

  // ---- job render --------------------------------------------------------------
  function stepIcon(state) {
    if (state === "ok") return "✓";
    if (state === "failed") return "✕";
    if (state === "running") return "•";
    if (state === "skipped") return "–";
    return "…";
  }
  var STEP_LABELS = {
    preflight: "Preflight — drive connected",
    bootHook: "Ensure boot hook",
    mount: "Mount drive",
    composePatch: "Patch Plex compose",
    recreate: "Recreate Plex container",
    verify: "Verify"
  };
  function stepLabel(name) { return STEP_LABELS[name] || String(name || "step"); }

  function renderJob(job) {
    var card = $("jobCard");
    if (!card) return;
    if (!job || !job.jobId) {
      card.style.display = "none";
      show("jobBadge", false);
      return;
    }
    card.style.display = "block";
    show("jobBadge", !!job.running);
    setText("jobKind", (job.trigger ? (job.trigger + " ") : "") + (job.running ? "running" : "finished") + (job.result != null && !job.running ? (" · " + String(typeof job.result === "object" ? JSON.stringify(job.result) : job.result)) : ""));

    var steps = job.steps || [];
    var stepsHtml = "";
    var logLines = [];
    for (var i = 0; i < steps.length; i++) {
      var st = steps[i] || {};
      var state = st.state || "pending";
      stepsHtml += '<li class="step step-' + esc(state) + '">'
        + '<span class="step-ic">' + stepIcon(state) + "</span>"
        + '<span class="step-label">' + esc(stepLabel(st.name)) + "</span>"
        + '<span class="step-state-txt">' + esc(state) + "</span>"
        + "</li>";
      var stepLog = st.log || [];
      for (var k = 0; k < stepLog.length; k++) {
        var entry = stepLog[k] || {};
        var ts = entry.ts ? (new Date(entry.ts).toLocaleTimeString()) : "";
        logLines.push("[" + ts + "] " + stepLabel(st.name) + ": " + (entry.line || ""));
      }
    }
    setHtml("jobSteps", stepsHtml);

    var logEl = $("jobLog");
    if (logEl) {
      logEl.textContent = logLines.join("\n");
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  // ---- events render -------------------------------------------------------
  function renderEvents(list) {
    var box = $("eventsList");
    var empty = $("eventsEmpty");
    if (!box) return;
    if (!list || !list.length) { box.innerHTML = ""; if (empty) empty.style.display = "block"; return; }
    if (empty) empty.style.display = "none";
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var ev = list[i] || {};
      var level = ev.level || ev.type || "info";
      var cls = "chip-info";
      if (level === "ok" || level === "success") cls = "chip-ok";
      else if (level === "warn" || level === "warning") cls = "chip-warn";
      else if (level === "error" || level === "fail" || level === "failed") cls = "chip-error";
      var when = ev.at || ev.ts || ev.timestamp;
      var message = ev.message || ev.summary || ev.text || "";
      var detail = ev.detail || ev.body || "";
      html += '<li class="log-item">'
        + '<span class="chip ' + cls + '">' + esc(level) + "</span>"
        + '<div class="log-main">'
        + '<div class="log-title">' + esc(message) + "</div>"
        + '<div class="log-sub">' + relSpan(when) + "</div>"
        + (detail ? ('<div class="log-body">' + esc(detail) + "</div>") : "")
        + "</div></li>";
    }
    box.innerHTML = html;
    refreshRelTimes();
  }

  // ---- connection note -----------------------------------------------------
  function connOk() { var n = $("connNote"); if (n) n.style.display = "none"; }
  function connFail() { var n = $("connNote"); if (n) n.style.display = "inline"; }

  // ---- loaders ---------------------------------------------------------------
  async function loadStatus() {
    if (document.hidden) return;
    var res = await apiGet("/api/status");
    if (res.ok) { renderStatus(res.data); connOk(); } else { connFail(); }
  }

  async function loadJob() {
    if (document.hidden) return;
    var res = await apiGet("/api/job");
    if (!res.ok) return;
    var job = res.data;
    renderJob(job);
    var running = !!(job && job.running);
    if (running !== jobRunning) {
      jobRunning = running;
      setJobPollRate(running ? 1000 : 5000);
      if (!running) { loadEvents(); loadStatus(); }
    }
  }
  function setJobPollRate(ms) {
    if (jobPollTimer) clearInterval(jobPollTimer);
    jobPollTimer = setInterval(loadJob, ms);
  }

  async function loadEvents() {
    if (document.hidden) return;
    var res = await apiGet("/api/events?limit=100");
    if (res.ok) renderEvents(res.data || []);
  }

  async function loadSettings() {
    var res = await apiGet("/api/settings");
    if (res.ok) fillSettingsForm(res.data || {});
  }

  // ---- settings form ---------------------------------------------------------
  function fillSettingsForm(c) {
    c = c || {};
    setV("cfg_uuid", c.uuid || "");
    setV("cfg_fsType", c.fsType || "");
    setV("cfg_mountPoint", c.mountPoint || "");
    setV("cfg_mediaSubdir", c.mediaSubdir || "");
    setV("cfg_folders", (c.folders || []).join(", "));
    setV("cfg_plexAppId", c.plexAppId || "");
    setV("cfg_umbrelRoot", c.umbrelRoot || "");
    setV("cfg_containerMediaPath", c.containerMediaPath || "");
    var ah = c.autoHeal || {};
    setC("cfg_autoHealEnabled", ah.enabled !== false);
    setV("cfg_intervalSec", ah.intervalSec != null ? ah.intervalSec : 30);
    setV("cfg_cooldownSec", ah.cooldownSec != null ? ah.cooldownSec : 300);
    setV("cfg_maxConsecutiveFailures", ah.maxConsecutiveFailures != null ? ah.maxConsecutiveFailures : 3);
    setV("cfg_requireConsecutiveBroken", ah.requireConsecutiveBroken != null ? ah.requireConsecutiveBroken : 2);
  }

  function collectSettings() {
    return {
      uuid: val("cfg_uuid").trim(),
      fsType: val("cfg_fsType").trim(),
      mountPoint: val("cfg_mountPoint").trim(),
      mediaSubdir: val("cfg_mediaSubdir").trim(),
      folders: val("cfg_folders").split(",").map(function (x) { return x.trim(); }).filter(function (x) { return x.length > 0; }),
      plexAppId: val("cfg_plexAppId").trim(),
      umbrelRoot: val("cfg_umbrelRoot").trim(),
      containerMediaPath: val("cfg_containerMediaPath").trim(),
      autoHeal: {
        enabled: checked("cfg_autoHealEnabled"),
        intervalSec: numVal("cfg_intervalSec", 30),
        cooldownSec: numVal("cfg_cooldownSec", 300),
        maxConsecutiveFailures: numVal("cfg_maxConsecutiveFailures", 3),
        requireConsecutiveBroken: numVal("cfg_requireConsecutiveBroken", 2)
      }
    };
  }

  // Client-side pre-validation mirroring spec section 5 exactly, so the user
  // gets inline errors before round-tripping to the server.
  function isAbsCleanPath(v) {
    return typeof v === "string" && v.length > 0 && v.charAt(0) === "/" && !/[\s"'\\]/.test(v);
  }
  function validateSettings(s) {
    var errs = {};
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s.uuid || "")) errs.uuid = "must be a canonical UUID (8-4-4-4-12 hex)";
    if (!s.fsType) errs.fsType = "required";
    if (!isAbsCleanPath(s.mountPoint)) errs.mountPoint = "must be an absolute path with no spaces, quotes, or backslashes";
    if (!s.mediaSubdir) errs.mediaSubdir = "required";
    if (!s.folders || !s.folders.length) errs.folders = "at least one folder is required";
    else if (s.folders.some(function (f) { return f.indexOf("/") !== -1; })) errs.folders = "folder names cannot contain \"/\"";
    if (!s.plexAppId) errs.plexAppId = "required";
    if (!isAbsCleanPath(s.umbrelRoot)) errs.umbrelRoot = "must be an absolute path with no spaces, quotes, or backslashes";
    if (!isAbsCleanPath(s.containerMediaPath)) errs.containerMediaPath = "must be an absolute path with no spaces, quotes, or backslashes";
    var ah = s.autoHeal || {};
    if (!(ah.intervalSec >= 10 && ah.intervalSec <= 3600)) errs.intervalSec = "must be between 10 and 3600";
    if (!(ah.cooldownSec >= 60 && ah.cooldownSec <= 86400)) errs.cooldownSec = "must be between 60 and 86400";
    if (!(ah.maxConsecutiveFailures >= 1)) errs.maxConsecutiveFailures = "must be at least 1";
    if (!(ah.requireConsecutiveBroken >= 1)) errs.requireConsecutiveBroken = "must be at least 1";
    return errs;
  }

  function clearFieldErrors() {
    var boxes = document.querySelectorAll(".field-err");
    for (var i = 0; i < boxes.length; i++) boxes[i].textContent = "";
  }
  function applyFieldErrors(errs) {
    for (var key in errs) {
      if (!Object.prototype.hasOwnProperty.call(errs, key)) continue;
      var el = $("err_" + key);
      if (el) el.textContent = errs[key];
    }
  }

  $("settingsForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var errBox = $("settingsErrors");
    if (errBox) { errBox.style.display = "none"; errBox.textContent = ""; }
    clearFieldErrors();

    var payload = collectSettings();
    var errs = validateSettings(payload);
    var hasErrs = false;
    for (var _k in errs) { if (Object.prototype.hasOwnProperty.call(errs, _k)) { hasErrs = true; break; } }
    if (hasErrs) {
      applyFieldErrors(errs);
      if (errBox) { errBox.textContent = "Fix the highlighted fields before saving."; errBox.style.display = "block"; }
      toast("Settings not saved — see errors above", "error");
      return;
    }

    var btn = $("saveBtn");
    var old = busy(btn, "Saving…");
    var res = await apiPut("/api/settings", payload);
    if (res.ok) {
      fillSettingsForm(res.data || payload);
      toast("Settings saved", "ok");
      loadStatus();
    } else {
      if (errBox) { errBox.textContent = res.error; errBox.style.display = "block"; }
      toast(res.error, "error");
    }
    unbusy(btn, old);
  });

  // ---- actions -----------------------------------------------------------------
  var RESTORE_OPERATIONS = [
    "Check that the configured drive is connected",
    "Ensure the boot-time remount hook is installed",
    "Mount the drive at the configured mount point (repair if stale)",
    "Patch the Plex compose file with the media volume",
    "Recreate the Plex container if it is missing the bind",
    "Verify media folders and record the result"
  ];

  function confirmRestore() {
    var lines = ["This will run a full restore:"];
    for (var i = 0; i < RESTORE_OPERATIONS.length; i++) lines.push((i + 1) + ". " + RESTORE_OPERATIONS[i]);
    lines.push("");
    lines.push("Continue?");
    return window.confirm(lines.join("\n"));
  }

  $("restoreBtn").addEventListener("click", async function () {
    if (!confirmRestore()) return;
    var btn = this;
    var old = busy(btn, "Starting…");
    var res = await apiPost("/api/restore", { confirm: true });
    if (res.ok) { toast("Full restore started", "ok"); jobRunning = true; setJobPollRate(1000); loadJob(); }
    else { toast(res.error, "error"); }
    unbusy(btn, old);
    loadStatus();
  });

  $("restartPlexBtn").addEventListener("click", async function () {
    var btn = this;
    var old = busy(btn, "Restarting…");
    var res = await apiPost("/api/restart-plex", { confirm: true });
    if (res.ok) { toast("Plex restart requested", "ok"); jobRunning = true; setJobPollRate(1000); loadJob(); }
    else { toast(res.error, "error"); }
    unbusy(btn, old);
    loadStatus();
  });

  $("checkNowBtn").addEventListener("click", async function () {
    var btn = this;
    var old = busy(btn, "Checking…");
    var res = await apiPost("/api/check", { confirm: true });
    if (res.ok) { toast("Check complete", "ok"); renderStatus(res.data); }
    else { toast(res.error, "error"); }
    unbusy(btn, old);
    loadEvents();
  });

  $("removeLegacyOverrideBtn").addEventListener("click", async function () {
    if (!window.confirm("Remove the unused docker-compose.override.yml? umbreld ignores it. It will be backed up to /data/backups first.")) return;
    var btn = this;
    var old = busy(btn, "Removing…");
    var res = await apiPost("/api/remove-legacy-override", { confirm: true });
    if (res.ok) { toast((res.data && res.data.removed) ? "Legacy override removed" : "No legacy override found", "ok"); }
    else { toast(res.error, "error"); }
    unbusy(btn, old);
    loadStatus(); loadEvents();
  });

  $("autoHealToggle").addEventListener("change", async function () {
    var el = this;
    var wanted = el.checked;
    el.disabled = true;
    var res = await apiPost("/api/auto-heal", { confirm: true, enabled: wanted });
    if (res.ok) { toast(wanted ? "Auto-heal enabled" : "Auto-heal disabled", "ok"); }
    else { el.checked = !wanted; toast(res.error, "error"); }
    el.disabled = false;
    loadStatus();
  });

  $("resetFailuresBtn").addEventListener("click", async function () {
    var btn = this;
    var old = busy(btn, "Resetting…");
    var res = await apiPost("/api/reset-failures", { confirm: true });
    if (res.ok) { toast("Failures reset — auto-heal resumed", "ok"); }
    else { toast(res.error, "error"); }
    unbusy(btn, old);
    loadStatus(); loadEvents();
  });

  // ---- ticking + boot ------------------------------------------------------
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { loadStatus(); loadJob(); loadEvents(); }
  });

  loadSettings();
  loadStatus();
  loadEvents();
  loadJob();
  setJobPollRate(5000);
  setInterval(loadStatus, 5000);
  setInterval(loadEvents, 15000);
  setInterval(refreshRelTimes, 1000);
})();
</script>
</body>
</html>`;
