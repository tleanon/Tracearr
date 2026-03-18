import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Activity, Clock, AlertCircle, CheckCircle2, Cpu } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { debugFetch } from '@/lib/debugFetch';

interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  dlqSize?: number;
  schedule?: string | null;
}

interface TrackedService {
  name: string;
  description: string;
  intervalMs: number;
  running: boolean;
}

interface TasksData {
  queues: {
    notifications: QueueStats | null;
    imports: QueueStats | null;
    maintenance: QueueStats | null;
    librarySync: QueueStats | null;
    versionCheck: QueueStats | null;
    inactivityCheck: QueueStats | null;
  };
  services: TrackedService[];
  timestamp: string;
}

const QUEUE_INFO: Array<{
  key: keyof TasksData['queues'];
  name: string;
  description: string;
  hasDlq?: boolean;
}> = [
  {
    key: 'notifications',
    name: 'Notifications',
    description: 'Discord, webhooks, push',
    hasDlq: true,
  },
  {
    key: 'imports',
    name: 'Imports',
    description: 'Tautulli / Jellystat history',
    hasDlq: true,
  },
  {
    key: 'maintenance',
    name: 'Maintenance',
    description: 'Data normalization & cleanup',
  },
  {
    key: 'librarySync',
    name: 'Library Sync',
    description: 'Library metadata sync',
  },
  {
    key: 'versionCheck',
    name: 'Version Check',
    description: 'GitHub release checking',
  },
  {
    key: 'inactivityCheck',
    name: 'Inactivity Check',
    description: 'Account inactivity monitoring',
  },
];

/**
 * Format a schedule from BullMQ into a human-readable string.
 * Handles cron patterns (e.g. "10 *\/12 * * *") and "every Nms" intervals.
 */
function formatSchedule(schedule: string): string {
  // Handle "every Nms" format
  const everyMatch = schedule.match(/^every (\d+)ms$/);
  if (everyMatch?.[1]) {
    const ms = parseInt(everyMatch[1], 10);
    return `Every ${formatInterval(ms)}`;
  }

  // Handle common cron patterns
  const cronMatch = schedule.match(/^\d+\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (cronMatch?.[1]) {
    const hours = parseInt(cronMatch[1], 10);
    return `Every ${hours}h`;
  }

  return schedule;
}

function formatInterval(ms: number): string {
  if (ms === 0) return 'Event-driven';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return `${hours}h`;
}

export function TasksTab() {
  const tasks = useQuery({
    queryKey: ['debug', 'tasks'],
    queryFn: () => debugFetch<TasksData>('/tasks'),
    refetchInterval: 10_000,
  });

  if (tasks.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading tasks...</p>;
  }

  if (tasks.isError || !tasks.data) {
    return <p className="text-destructive text-sm">Failed to load task status</p>;
  }

  const { queues, services } = tasks.data;

  return (
    <div className="space-y-6">
      {/* BullMQ Queues */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Job Queues
              </CardTitle>
              <CardDescription>BullMQ background job processing queues</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => tasks.refetch()}
              disabled={tasks.isFetching}
            >
              <RefreshCw className={cn('h-4 w-4', tasks.isFetching && 'animate-spin')} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left text-xs">
                  <th className="pr-4 pb-2 font-medium">Name</th>
                  <th className="pr-4 pb-2 font-medium">Description</th>
                  <th className="pr-4 pb-2 font-medium">Schedule</th>
                  <th className="pr-2 pb-2 text-right font-medium">Waiting</th>
                  <th className="pr-2 pb-2 text-right font-medium">Active</th>
                  <th className="pr-2 pb-2 text-right font-medium">Completed</th>
                  <th className="pr-2 pb-2 text-right font-medium">Failed</th>
                  <th className="pb-2 text-right font-medium">Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {QUEUE_INFO.map((info) => {
                  const stats = queues[info.key];
                  const isActive = stats ? stats.active > 0 : false;
                  const hasFailed = stats ? stats.failed > 0 : false;
                  const hasDlqItems = info.hasDlq && (stats?.dlqSize ?? 0) > 0;

                  return (
                    <tr key={info.key} className="border-b last:border-0">
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{info.name}</span>
                          {isActive && (
                            <Badge variant="default" className="gap-1 px-1.5 py-0 text-[10px]">
                              <Cpu className="h-2.5 w-2.5" />
                              Processing
                            </Badge>
                          )}
                          {(hasFailed || hasDlqItems) && (
                            <Badge variant="danger" className="gap-1 px-1.5 py-0 text-[10px]">
                              <AlertCircle className="h-2.5 w-2.5" />
                              {hasDlqItems ? `DLQ: ${stats?.dlqSize}` : 'Failed'}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="text-muted-foreground py-2.5 pr-4">{info.description}</td>
                      <td className="text-muted-foreground py-2.5 pr-4">
                        {stats?.schedule ? formatSchedule(stats.schedule) : 'On demand'}
                      </td>
                      {stats ? (
                        <>
                          <td className="py-2.5 pr-2 text-right tabular-nums">{stats.waiting}</td>
                          <td
                            className={cn(
                              'py-2.5 pr-2 text-right tabular-nums',
                              isActive && 'text-primary font-medium'
                            )}
                          >
                            {stats.active}
                          </td>
                          <td className="py-2.5 pr-2 text-right tabular-nums">
                            {stats.completed.toLocaleString()}
                          </td>
                          <td
                            className={cn(
                              'py-2.5 pr-2 text-right tabular-nums',
                              hasFailed && 'text-destructive font-medium'
                            )}
                          >
                            {stats.failed}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">{stats.delayed}</td>
                        </>
                      ) : (
                        <td colSpan={5} className="text-muted-foreground py-2.5 text-center">
                          Not initialized
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Interval Services */}
      {services.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Background Services
            </CardTitle>
            <CardDescription>Interval-based and event-driven background services</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left text-xs">
                    <th className="pr-4 pb-2 font-medium">Name</th>
                    <th className="pr-4 pb-2 font-medium">Description</th>
                    <th className="pr-4 pb-2 font-medium">Interval</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {services.map((service) => (
                    <tr key={service.name} className="border-b last:border-0">
                      <td className="py-2.5 pr-4 font-medium">{service.name}</td>
                      <td className="text-muted-foreground py-2.5 pr-4">{service.description}</td>
                      <td className="text-muted-foreground py-2.5 pr-4">
                        {formatInterval(service.intervalMs)}
                      </td>
                      <td className="py-2.5">
                        {service.running ? (
                          <Badge variant="success" className="gap-1 text-xs">
                            <CheckCircle2 className="h-3 w-3" />
                            Running
                          </Badge>
                        ) : (
                          <Badge variant="danger" className="gap-1 text-xs">
                            <AlertCircle className="h-3 w-3" />
                            Stopped
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
