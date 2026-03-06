import { Database, Loader2, Server, CheckCircle2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';
import { LogoIcon } from '@/components/brand/Logo';
import { RESTORE_PHASES } from '@tracearr/shared';

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`}
    />
  );
}

function RestoreProgress() {
  const { t } = useTranslation('pages');
  const { restore } = useMaintenanceMode();

  if (!restore) return null;

  const currentIdx = (RESTORE_PHASES as readonly string[]).indexOf(restore.phase);
  const isFailed = restore.phase === 'failed';
  const failedIdx = isFailed
    ? (RESTORE_PHASES as readonly string[]).indexOf(restore.failedAtPhase ?? '')
    : -1;
  const effectiveIdx = isFailed ? failedIdx : currentIdx;

  return (
    <div className="w-full max-w-md space-y-4">
      <h1 className="text-foreground text-center text-2xl font-bold">
        {t('maintenance.restoreTitle')}
      </h1>
      <div className="space-y-2">
        {RESTORE_PHASES.map((phase, idx) => {
          const isActive = !isFailed && phase === restore.phase;
          const isDone = idx < effectiveIdx;
          const isFailedPhase = isFailed && idx === failedIdx;
          return (
            <div key={phase} className="flex items-center gap-3 text-sm">
              {isDone ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
              ) : isFailedPhase ? (
                <XCircle className="text-destructive h-4 w-4 shrink-0" />
              ) : isActive ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
              ) : (
                <span className="bg-muted h-4 w-4 shrink-0 rounded-full" />
              )}
              <span
                className={
                  isFailedPhase
                    ? 'text-destructive font-medium'
                    : isActive
                      ? 'text-foreground font-medium'
                      : isDone
                        ? 'text-muted-foreground'
                        : 'text-muted-foreground/50'
                }
              >
                {t(`maintenance.restorePhase.${phase}`)}
              </span>
            </div>
          );
        })}
      </div>
      {isFailed && (
        <div className="border-destructive/50 bg-destructive/10 rounded-md border p-3">
          <div className="flex items-start gap-2">
            <XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
            <div className="text-destructive text-sm">
              <p className="font-medium">{t('maintenance.restoreFailed')}</p>
              {restore.error && <p className="mt-1 opacity-80">{restore.error}</p>}
              {restore.message && <p className="mt-1 opacity-60">{restore.message}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Maintenance() {
  const { t } = useTranslation('pages');
  const { db, redis, wasReady, restore } = useMaintenanceMode();

  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center space-y-6 p-4">
      <LogoIcon className="h-16 w-16 opacity-50" />

      {restore ? (
        <RestoreProgress />
      ) : (
        <>
          <h1 className="text-foreground text-2xl font-bold">
            {wasReady ? t('maintenance.interruptionTitle') : t('maintenance.startingTitle')}
          </h1>
          <p className="text-muted-foreground max-w-md text-center">
            {wasReady
              ? t('maintenance.interruptionDescription')
              : t('maintenance.startingDescription')}
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
        </>
      )}
    </div>
  );
}
