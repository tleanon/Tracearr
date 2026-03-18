import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { BASE_PATH } from '@/lib/basePath';

interface HealthResponse {
  mode?: string;
  wasReady?: boolean;
  db?: boolean;
  redis?: boolean;
}

interface MaintenanceState {
  isInMaintenance: boolean;
  /** True if the app was previously in ready mode before entering maintenance */
  wasReady: boolean;
  db: boolean;
  redis: boolean;
}

const MAINTENANCE_POLL_MS = 5000;
const NORMAL_POLL_MS = 60000;
const MAINTENANCE_EVENT = 'tracearr:maintenance-mode';

const MaintenanceContext = createContext<MaintenanceState>({
  isInMaintenance: false,
  wasReady: false,
  db: true,
  redis: true,
});

export function MaintenanceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MaintenanceState>({
    isInMaintenance: false,
    wasReady: false,
    db: true,
    redis: true,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/health`);
      const data = (await res.json()) as HealthResponse;
      const inMaintenance = data.mode === 'maintenance' || data.mode === 'starting';
      setState({
        isInMaintenance: inMaintenance,
        wasReady: data.wasReady === true || !inMaintenance,
        db: data.db ?? false,
        redis: data.redis ?? false,
      });
    } catch {
      // Server completely unreachable
      setState((prev) => ({ ...prev, isInMaintenance: true, db: false, redis: false }));
    }
  }, []);

  // Initial check
  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  // Polling interval — faster when in maintenance, slower when healthy
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    const interval = state.isInMaintenance ? MAINTENANCE_POLL_MS : NORMAL_POLL_MS;
    intervalRef.current = setInterval(() => {
      void checkHealth();
    }, interval);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [state.isInMaintenance, checkHealth]);

  // Listen for 503 maintenance events from the API client
  useEffect(() => {
    const handler = () => {
      setState((prev) => ({ ...prev, isInMaintenance: true }));
      // Trigger an immediate health check to get accurate db/redis status
      void checkHealth();
    };
    globalThis.addEventListener(MAINTENANCE_EVENT, handler);
    return () => globalThis.removeEventListener(MAINTENANCE_EVENT, handler);
  }, [checkHealth]);

  return <MaintenanceContext.Provider value={state}>{children}</MaintenanceContext.Provider>;
}

export function useMaintenanceMode(): MaintenanceState {
  return useContext(MaintenanceContext);
}

export { MAINTENANCE_EVENT };
