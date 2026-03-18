/**
 * Server operational state singleton.
 *
 * Tracks whether the server is starting up, in maintenance mode
 * (DB/Redis unavailable), or fully ready.
 */

export type ServerMode = 'starting' | 'maintenance' | 'ready';

type ModeChangeListener = (newMode: ServerMode, prevMode: ServerMode) => void;

let _mode: ServerMode = 'starting';
let _wasReady = false;
let _servicesInitialized = false;
let _dbHealthy = false;
let _redisHealthy = false;
const _listeners: ModeChangeListener[] = [];

export function getServerMode(): ServerMode {
  return _mode;
}

export function setServerMode(mode: ServerMode): void {
  const prev = _mode;
  _mode = mode;
  if (mode === 'ready') _wasReady = true;
  if (prev !== mode) {
    for (const listener of _listeners) {
      listener(mode, prev);
    }
  }
}

/** Register a callback that fires whenever the server mode changes. */
export function onModeChange(listener: ModeChangeListener): void {
  _listeners.push(listener);
}

export function isMaintenance(): boolean {
  return _mode === 'maintenance';
}

/** True if the server has ever reached 'ready' mode during this process lifetime. */
export function wasEverReady(): boolean {
  return _wasReady;
}

export function isServicesInitialized(): boolean {
  return _servicesInitialized;
}

export function setServicesInitialized(v: boolean): void {
  _servicesInitialized = v;
}

/** Cached DB health from the background health check interval. */
export function isDbHealthy(): boolean {
  return _dbHealthy;
}

export function setDbHealthy(v: boolean): void {
  _dbHealthy = v;
}

/** Cached Redis health — updated by startup probe, recovery loop, and ioredis events. */
export function isRedisHealthy(): boolean {
  return _redisHealthy;
}

export function setRedisHealthy(v: boolean): void {
  _redisHealthy = v;
}
