import { Database, Loader2, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';
import { LogoIcon } from '@/components/brand/Logo';

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`}
    />
  );
}

export function Maintenance() {
  const { t } = useTranslation('pages');
  const { db, redis, wasReady } = useMaintenanceMode();

  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center space-y-6 p-4">
      <LogoIcon className="h-16 w-16 opacity-50" />
      <h1 className="text-foreground text-2xl font-bold">
        {wasReady ? t('maintenance.interruptionTitle') : t('maintenance.startingTitle')}
      </h1>
      <p className="text-muted-foreground max-w-md text-center">
        {wasReady ? t('maintenance.interruptionDescription') : t('maintenance.startingDescription')}
      </p>
      <div className="text-muted-foreground flex gap-6 text-sm">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4" />
          <span>TimescaleDB</span>
          <StatusDot ok={db} />
        </div>
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4" />
          <span>Redis</span>
          <StatusDot ok={redis} />
        </div>
      </div>
      <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
    </div>
  );
}
