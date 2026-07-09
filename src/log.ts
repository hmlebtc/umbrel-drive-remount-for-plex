/**
 * Timestamped stdout/stderr logging in a `[YYYY-MM-DD HH:MM:SS] message`
 * format (mirrors the OCEAN reference app) so operators tailing docker logs
 * see a familiar shape.
 */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function timestamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function log(msg: string): void {
  console.log(`[${timestamp()}] ${msg}`);
}

export function logError(msg: string): void {
  console.error(`[${timestamp()}] ${msg}`);
}
