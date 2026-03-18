/**
 * Tailscale VPN integration service
 *
 * Manages the tailscaled daemon as a child process, providing one-click
 * VPN setup from the Tracearr settings UI. Runs in userspace networking
 * mode (no root, no Docker capabilities).
 *
 * State machine: disabled → starting → awaiting_auth → connected → error
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { promisify } from 'node:util';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { registerService, unregisterService } from './serviceTracker.js';
import type { TailscaleStatus, TailscaleInfo, TailscaleExitNode } from '@tracearr/shared';

const execFileAsync = promisify(execFile);

const SETTINGS_ID = 1;
const TAILSCALED_BIN = '/usr/sbin/tailscaled';
const TAILSCALE_BIN = '/usr/bin/tailscale';
const STATE_FILE = '/tmp/ts-state';
const SOCKET_FILE = '/tmp/tailscaled.sock';
const HEALTH_CHECK_MS = 30_000;
const SERVICE_ID = 'tailscale';
const MAX_RESTART_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const BASE_PATH = process.env.BASE_PATH?.replace(/\/+$/, '').replace(/^\/?/, '/') || '';

/** Minimal env for tailscale child processes — avoids leaking NODE/app env vars like PORT */
const TAILSCALE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/tmp',
};

class TailscaleService {
  private status: TailscaleStatus = 'disabled';
  private authUrl: string | null = null;
  private hostname: string | null = null;
  private dnsName: string | null = null;
  private tailnetName: string | null = null;
  private tailnetIp: string | null = null;
  private exitNodes: TailscaleExitNode[] = [];
  private error: string | null = null;
  private daemonLogs = '';

  private daemonProcess: ChildProcess | null = null;
  private upProcess: ChildProcess | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private stateWatcher: FSWatcher | null = null;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  /**
   * Check if the tailscale binaries are installed
   */
  isAvailable(): boolean {
    return existsSync(TAILSCALED_BIN) && existsSync(TAILSCALE_BIN);
  }

  /**
   * Get current status for API responses
   */
  getInfo(): TailscaleInfo {
    return {
      status: this.status,
      authUrl: this.status === 'awaiting_auth' ? this.authUrl : null,
      hostname: this.hostname,
      dnsName: this.dnsName,
      tailnetName: this.tailnetName,
      tailnetIp: this.tailnetIp,
      tailnetUrl: this.dnsName ? `http://${this.dnsName}:${PORT}${BASE_PATH}/` : null,
      exitNodes: this.exitNodes,
      error: this.status === 'error' ? this.error : null,
      available: this.isAvailable(),
    };
  }

  /**
   * Get daemon logs from the current run
   */
  getLogs(): string {
    return this.daemonLogs;
  }

  /**
   * Refresh live status from tailscale CLI then return info
   */
  async getLiveInfo(): Promise<TailscaleInfo> {
    if (this.status === 'connected') {
      await this.refreshStatus();
    }
    return this.getInfo();
  }

  // Exit node disabled — this will come back when we implement SOCKS proxy support
  //
  // async setExitNode(id: string | null): Promise<TailscaleInfo> {
  //   if (this.status !== 'connected') {
  //     return this.getInfo();
  //   }
  //   const exitNodeArg = id ? (this.exitNodes.find((n) => n.id === id)?.hostname ?? id) : '';
  //   await execFileAsync(
  //     TAILSCALE_BIN,
  //     [`--socket=${SOCKET_FILE}`, 'set', `--exit-node=${exitNodeArg}`],
  //     { env: TAILSCALE_ENV }
  //   );
  //   await this.persistState();
  //   await this.refreshStatus();
  //   return this.getInfo();
  // }

  /**
   * Called on startup — reads DB settings, starts daemon if previously enabled
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!this.isAvailable()) {
      console.log('[Tailscale] Binary not found — feature unavailable');
      return;
    }

    try {
      const [row] = await db
        .select({
          tailscaleEnabled: settings.tailscaleEnabled,
          tailscaleState: settings.tailscaleState,
          tailscaleHostname: settings.tailscaleHostname,
        })
        .from(settings)
        .where(eq(settings.id, SETTINGS_ID))
        .limit(1);

      if (!row?.tailscaleEnabled) {
        console.log('[Tailscale] Initialized (disabled)');
        return;
      }

      this.hostname = row.tailscaleHostname ?? null;

      await this.startDaemon();
      console.log('[Tailscale] Initialized (enabled, starting daemon)');
    } catch (err) {
      console.error('[Tailscale] Failed to initialize:', err);
    }
  }

  /**
   * Enable Tailscale — starts daemon and auth flow
   */
  async enable(hostname?: string): Promise<TailscaleInfo> {
    if (!this.isAvailable()) {
      this.error = 'Tailscale binary not found';
      return this.getInfo();
    }

    if (this.status !== 'disabled' && this.status !== 'error') {
      return this.getInfo();
    }

    this.hostname = hostname || 'tracearr';
    this.error = null;
    this.restartAttempts = 0;

    // Persist enabled state to DB
    await db
      .update(settings)
      .set({
        tailscaleEnabled: true,
        tailscaleHostname: this.hostname,
        updatedAt: new Date(),
      })
      .where(eq(settings.id, SETTINGS_ID));

    await this.startDaemon();
    return this.getInfo();
  }

  /**
   * Disable Tailscale — kills daemon, clears state
   */
  async disable(): Promise<TailscaleInfo> {
    this.status = 'stopping';
    this.stopHealthCheck();
    this.stopStateWatcher();
    this.clearRestartTimer();

    // Kill the daemon
    await this.killAll();

    // Mark as disabled in DB but preserve state + hostname for re-enable
    await db
      .update(settings)
      .set({
        tailscaleEnabled: false,
        updatedAt: new Date(),
      })
      .where(eq(settings.id, SETTINGS_ID));

    this.status = 'disabled';
    this.authUrl = null;
    this.dnsName = null;
    this.tailnetName = null;
    this.tailnetIp = null;
    this.error = null;
    this.restartAttempts = 0;

    console.log('[Tailscale] Disabled');
    return this.getInfo();
  }

  /**
   * Reset Tailscale — wipe all state so the next enable starts fresh with a new auth flow.
   * Kills processes, deletes state file, clears DB.
   */
  async reset(): Promise<TailscaleInfo> {
    this.status = 'stopping';
    this.stopHealthCheck();
    this.stopStateWatcher();
    this.clearRestartTimer();

    await this.killAll();

    // Delete the on-disk state file so tailscaled forgets the machine identity
    try {
      if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    } catch {
      // Ignore — file may already be gone
    }
    try {
      if (existsSync(SOCKET_FILE)) unlinkSync(SOCKET_FILE);
    } catch {
      // Ignore
    }
    try {
      rmSync('/tmp/tailscale', { recursive: true, force: true });
    } catch {
      // Ignore
    }

    // Clear all tailscale columns in DB
    await db
      .update(settings)
      .set({
        tailscaleEnabled: false,
        tailscaleState: null,
        tailscaleHostname: null,
        updatedAt: new Date(),
      })
      .where(eq(settings.id, SETTINGS_ID));

    this.status = 'disabled';
    this.authUrl = null;
    this.hostname = null;
    this.dnsName = null;
    this.tailnetName = null;
    this.tailnetIp = null;
    this.error = null;
    this.restartAttempts = 0;

    console.log('[Tailscale] Reset — all state wiped');
    return this.getInfo();
  }

  /**
   * Graceful shutdown for server close
   */
  async shutdown(): Promise<void> {
    this.stopHealthCheck();
    this.stopStateWatcher();
    this.clearRestartTimer();

    if (this.daemonProcess) {
      await this.killAll();
      console.log('[Tailscale] Shut down');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: daemon lifecycle
  // ---------------------------------------------------------------------------

  private async startDaemon(): Promise<void> {
    this.status = 'starting';
    this.error = null;

    // Restore state file from DB if missing (survives container restarts, crash loops)
    let hasExistingState = existsSync(STATE_FILE);
    if (!hasExistingState) {
      try {
        const [row] = await db
          .select({ tailscaleState: settings.tailscaleState })
          .from(settings)
          .where(eq(settings.id, SETTINGS_ID))
          .limit(1);

        if (row?.tailscaleState) {
          writeFileSync(STATE_FILE, Buffer.from(row.tailscaleState, 'base64'));
          hasExistingState = true;
          console.log('[Tailscale] Restored state from database');
        }
      } catch (err) {
        console.error('[Tailscale] Failed to restore state:', err);
      }
    }

    // Clean up any orphaned processes from previous runs
    await this.killAll();

    try {
      // Start tailscaled in userspace networking mode
      const args = [
        '--tun=userspace-networking',
        '--statedir=/tmp/tailscale',
        `--state=${STATE_FILE}`,
        `--socket=${SOCKET_FILE}`,
        '--port=0',
        '--no-logs-no-support',
      ];

      this.daemonProcess = spawn(TAILSCALED_BIN, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: TAILSCALE_ENV,
      });

      // Collect stderr for logs and error reporting
      this.daemonLogs = '';
      this.daemonProcess.stderr?.on('data', (chunk: Buffer) => {
        this.daemonLogs += chunk.toString();
        // Keep only last 8KB to avoid unbounded memory
        if (this.daemonLogs.length > 8192) {
          this.daemonLogs = this.daemonLogs.slice(-8192);
        }
      });

      this.daemonProcess.on('exit', (code, signal) => {
        console.log(`[Tailscale] Daemon exited (code=${code}, signal=${signal})`);

        // If daemonProcess was already cleared, this is an intentional kill (e.g. killAll during restart)
        if (!this.daemonProcess) return;
        this.daemonProcess = null;

        // If we're stopping or disabling, don't restart
        if (this.status === 'stopping' || this.status === 'disabled') return;

        // Only auto-restart if we were connected (i.e. a genuine crash during normal operation).
        // During starting/awaiting_auth/error, just report the failure and let the user retry.
        const wasConnected = this.status === 'connected';
        this.error = `Daemon exited unexpectedly (code=${code})${this.daemonLogs ? `: ${this.daemonLogs.slice(-200)}` : ''}`;
        this.status = 'error';
        if (wasConnected) {
          this.scheduleRestart();
        }
      });

      // Wait a moment for the daemon to start listening on the socket
      await this.waitForSocket();

      // Start watching the state file for changes
      this.startStateWatcher();

      if (hasExistingState) {
        // State exists — tailscaled will auto-connect. Poll for status instead
        // of running `tailscale up`, which resets preferences like exit-node.
        this.pollForConnection().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Tailscale] Connection poll failed:', msg);
          this.error = msg;
          this.status = 'error';
          this.scheduleRestart();
        });
      } else {
        // No prior state — run `tailscale up` for fresh auth flow
        this.runTailscaleUp().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Tailscale] tailscale up failed:', msg);
          this.error = msg;
          this.status = 'error';
          this.scheduleRestart();
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Tailscale] Failed to start daemon:', msg);
      this.error = msg;
      this.status = 'error';
      this.scheduleRestart();
    }
  }

  private waitForSocket(): Promise<void> {
    return new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        if (existsSync(SOCKET_FILE)) {
          resolve();
        } else if (attempts >= 50) {
          // 5 seconds max
          resolve(); // Proceed anyway, tailscale up will fail with a clear error
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  private async runTailscaleUp(): Promise<void> {
    const args = [
      `--socket=${SOCKET_FILE}`,
      'up',
      '--json',
      `--hostname=${this.hostname || 'tracearr'}`,
    ];

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(TAILSCALE_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: TAILSCALE_ENV,
      });
      this.upProcess = proc;

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const settle = (fn: () => void) => {
        if (resolved) return;
        resolved = true;
        fn();
      };

      const tryParseOutput = () => {
        // tailscale up --json outputs a single JSON object that may arrive in chunks.
        // Try to parse what we have so far.
        const trimmed = stdout.trim();
        if (!trimmed) return;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return; // Incomplete JSON, wait for more data
        }

        if (data.AuthURL && typeof data.AuthURL === 'string') {
          this.authUrl = data.AuthURL;
          this.status = 'awaiting_auth';
          console.log('[Tailscale] Auth URL received — waiting for user authorization');
          // Resolve immediately so the API can return the auth URL to the frontend.
          // The process keeps running in the background until auth completes.
          settle(() => resolve());
        }

        if (data.BackendState === 'Running') {
          console.log('[Tailscale] Already authenticated');
        }
      };

      if (proc.stdout) {
        proc.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          tryParseOutput();
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      proc.on('exit', (code) => {
        // If upProcess was already cleared, this is an intentional kill (e.g. killAll during restart)
        if (!this.upProcess) {
          settle(() => resolve());
          return;
        }
        this.upProcess = null;

        // If we're stopping or disabled, don't touch state — disable()/reset() owns it
        if (this.status === 'stopping' || this.status === 'disabled') {
          settle(() => resolve());
          return;
        }

        if (code === 0) {
          this.authUrl = null;
          void this.onConnected()
            .then(() => {
              settle(() => resolve());
            })
            .catch((err: unknown) => {
              settle(() => reject(err instanceof Error ? err : new Error(String(err))));
            });
        } else {
          const msg = stderr.trim() || `tailscale up exited with code ${code}`;
          if (!resolved) {
            settle(() => reject(new Error(msg)));
          } else {
            // Already resolved (auth URL was sent to frontend), report error via state
            console.error('[Tailscale] tailscale up failed after auth:', msg);
            this.error = msg;
            this.status = 'error';
          }
        }
      });
    });
  }

  /**
   * Poll `tailscale status --json` for auto-reconnection (used when state
   * exists so we skip `tailscale up` to preserve prefs like exit-node).
   * Falls back to `runTailscaleUp()` if re-auth is needed.
   */
  private async pollForConnection(): Promise<void> {
    const POLL_MS = 2_000;
    const CONNECT_TIMEOUT_MS = 60_000;
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.status === 'stopping' || this.status === 'disabled') return;

      try {
        const { stdout } = await execFileAsync(
          TAILSCALE_BIN,
          [`--socket=${SOCKET_FILE}`, 'status', '--json'],
          { env: TAILSCALE_ENV }
        );

        const data = JSON.parse(stdout) as {
          BackendState?: string;
          AuthURL?: string;
        };

        if (data.BackendState === 'Running') {
          await this.onConnected();
          return;
        }

        if (data.BackendState === 'NeedsLogin') {
          // Auth expired — hand off to runTailscaleUp for the full auth flow
          console.log('[Tailscale] Auth expired — running tailscale up for re-auth');
          return await this.runTailscaleUp();
        }
      } catch {
        // Status command may fail while daemon is still starting
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    throw new Error('Timed out waiting for tailscale to connect');
  }

  private async onConnected(): Promise<void> {
    this.status = 'connected';
    this.error = null;
    this.authUrl = null;
    this.restartAttempts = 0;

    // Disable auto-updates — updates are managed via Docker image
    try {
      await execFileAsync(
        TAILSCALE_BIN,
        [
          `--socket=${SOCKET_FILE}`,
          'set',
          `--hostname=${this.hostname || 'tracearr'}`,
          '--auto-update=false',
          '--update-check=false',
        ],
        { env: TAILSCALE_ENV }
      );
      await this.persistState();
    } catch {
      // Non-critical — older versions may not support this flag
    }

    // Get status to populate tailnet IP, hostname, and key expiry
    await this.refreshStatus();

    // Start periodic health checks
    this.startHealthCheck();

    console.log(`[Tailscale] Connected — IP: ${this.tailnetIp}, hostname: ${this.hostname}`);
  }

  private async refreshStatus(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        TAILSCALE_BIN,
        [`--socket=${SOCKET_FILE}`, 'status', '--json'],
        { env: TAILSCALE_ENV }
      );

      const data = JSON.parse(stdout) as {
        Self?: {
          TailscaleIPs?: string[];
          HostName?: string;
          DNSName?: string;
          CapMap?: Record<string, unknown[]>;
        };
        Peer?: Record<
          string,
          {
            PublicKey?: string;
            HostName?: string;
            DNSName?: string;
            TailscaleIPs?: string[];
            Online?: boolean;
            ExitNode?: boolean;
            ExitNodeOption?: boolean;
          }
        >;
      };

      if (data.Self) {
        this.tailnetIp = data.Self.TailscaleIPs?.[0] ?? null;
        this.hostname = data.Self.HostName ?? this.hostname;
        this.dnsName = data.Self.DNSName?.replace(/\.$/, '') ?? null;

        // tailnet display name is in CapMap['tailnet-display-name']
        const displayNameCap = data.Self.CapMap?.['tailnet-display-name'];
        if (Array.isArray(displayNameCap) && displayNameCap.length > 0) {
          const first = displayNameCap[0];
          this.tailnetName =
            typeof first === 'string'
              ? first
              : Array.isArray(first) && typeof first[0] === 'string'
                ? first[0]
                : null;
        } else {
          this.tailnetName = null;
        }
      }

      // Parse exit node options from peers
      this.exitNodes = Object.values(data.Peer ?? {})
        .filter((p) => p.ExitNodeOption)
        .map((p) => ({
          id: p.PublicKey ?? '',
          hostname: p.HostName ?? '',
          dnsName: p.DNSName?.replace(/\.$/, '') ?? '',
          ip: p.TailscaleIPs?.[0] ?? '',
          online: p.Online ?? false,
          active: p.ExitNode ?? false,
        }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Tailscale] Failed to get status:', msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: state file persistence via fs.watch
  // ---------------------------------------------------------------------------

  private startStateWatcher(): void {
    this.stopStateWatcher();

    // Watch for the state file to be created/modified
    // On Linux (Docker), fs.watch uses inotify which works on overlayfs/tmpfs
    try {
      this.stateWatcher = watch(STATE_FILE, () => {
        void this.persistState();
      });
      this.stateWatcher.on('error', (err) => {
        console.warn('[Tailscale] State watcher error:', err.message);
      });
    } catch {
      // File might not exist yet — will be created by tailscaled
      // Watch the directory instead
      this.stateWatcher = watch('/tmp', (eventType, filename) => {
        if (filename === 'ts-state') {
          void this.persistState();
        }
      });
      this.stateWatcher.on('error', (err) => {
        console.warn('[Tailscale] State dir watcher error:', err.message);
      });
    }
  }

  private stopStateWatcher(): void {
    if (this.stateWatcher) {
      this.stateWatcher.close();
      this.stateWatcher = null;
    }
  }

  private async persistState(): Promise<void> {
    try {
      if (!existsSync(STATE_FILE)) return;

      const stateData = readFileSync(STATE_FILE);
      const base64State = stateData.toString('base64');

      await db
        .update(settings)
        .set({
          tailscaleState: base64State,
          updatedAt: new Date(),
        })
        .where(eq(settings.id, SETTINGS_ID));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Tailscale] Failed to persist state:', msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: health check
  // ---------------------------------------------------------------------------

  private startHealthCheck(): void {
    this.stopHealthCheck();

    this.healthInterval = setInterval(() => {
      void this.healthCheck();
    }, HEALTH_CHECK_MS);

    registerService(SERVICE_ID, {
      name: 'Tailscale',
      description: 'Monitors Tailscale VPN connection status',
      intervalMs: HEALTH_CHECK_MS,
    });
  }

  private stopHealthCheck(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
      unregisterService(SERVICE_ID);
    }
  }

  private async healthCheck(): Promise<void> {
    try {
      await this.refreshStatus();

      // Check if daemon process is still running
      if (!this.daemonProcess && this.status === 'connected') {
        console.warn('[Tailscale] Daemon process gone — marking as error');
        this.status = 'error';
        this.error = 'Daemon process terminated unexpectedly';
        this.scheduleRestart();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Tailscale] Health check failed:', msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: auto-restart with exponential backoff
  // ---------------------------------------------------------------------------

  private scheduleRestart(): void {
    this.clearRestartTimer();

    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      console.error(
        `[Tailscale] Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached — giving up`
      );
      this.status = 'error';
      this.error = `Daemon failed to stay running after ${MAX_RESTART_ATTEMPTS} restart attempts`;
      return;
    }

    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.restartAttempts), BACKOFF_CAP_MS);
    this.restartAttempts++;

    console.log(
      `[Tailscale] Scheduling restart attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS} in ${delay}ms`
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startDaemon().catch((err: unknown) => {
        console.error('[Tailscale] Restart failed:', err);
      });
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: process cleanup
  // ---------------------------------------------------------------------------

  /**
   * Kill tracked child processes (daemon + CLI) then sweep for any orphans.
   */
  private async killAll(): Promise<void> {
    // Kill the tracked tailscale up process first
    this.killProcess(this.upProcess);
    this.upProcess = null;

    // Kill the tracked daemon process
    await this.killDaemonGracefully();

    // Sweep for any orphaned tailscale/tailscaled processes by name.
    // This catches processes spawned by earlier runs that we lost track of
    // (e.g. after a restart loop, or stale processes from a previous boot).
    try {
      await execFileAsync('pkill', ['-f', TAILSCALED_BIN]);
    } catch {
      // pkill exits 1 if no processes matched — ignore
    }
    try {
      await execFileAsync('pkill', ['-f', TAILSCALE_BIN]);
    } catch {
      // pkill exits 1 if no processes matched — ignore
    }
  }

  private killProcess(proc: ChildProcess | null): void {
    if (!proc) return;
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already dead
    }
  }

  private killDaemonGracefully(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.daemonProcess) {
        resolve();
        return;
      }

      const proc = this.daemonProcess;
      this.daemonProcess = null;

      // Give the process 5s to exit gracefully
      const forceKillTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }, 5_000);

      proc.once('exit', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });

      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(forceKillTimer);
        resolve();
      }
    });
  }
}

export const tailscaleService = new TailscaleService();
