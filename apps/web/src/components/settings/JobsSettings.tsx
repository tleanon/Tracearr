import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Wrench,
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  AlertTriangle,
  Database,
  ArrowUpDown,
  RefreshCw,
  Globe,
  Calendar,
  Library,
  Trash2,
  CaseSensitive,
  History,
  HardDrive,
  Activity,
  ListTodo,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import type { MaintenanceJobProgress } from '@tracearr/shared';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/formatters';

interface JobOption {
  name: string;
  label: string;
  description: string;
  type: 'boolean';
  default: boolean;
}

type JobCategory = 'normalization' | 'backfill' | 'cleanup';

interface JobDefinition {
  type: string;
  category: JobCategory;
  name: string;
  description: string;
  options?: JobOption[];
}

interface JobHistoryItem {
  jobId: string;
  type: string;
  state: string;
  createdAt: number;
  finishedAt?: number;
  result?: {
    success: boolean;
    type: string;
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
    durationMs: number;
    message: string;
  };
}

interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

// Map job types to icons
const JOB_ICONS: Record<string, typeof Database> = {
  normalize_players: Database,
  normalize_countries: Globe,
  normalize_codecs: ArrowUpDown,
  fix_imported_progress: RefreshCw,
  backfill_user_dates: Calendar,
  backfill_library_snapshots: Library,
  rebuild_timescale_views: HardDrive,
  full_aggregate_rebuild: History,
  cleanup_old_chunks: Trash2,
  repair_corrupted_chunks: Wrench,
};

const CATEGORY_CONFIG: Record<JobCategory, { icon: typeof Database; label: string }> = {
  normalization: { icon: CaseSensitive, label: 'Normalization' },
  backfill: { icon: History, label: 'Backfill' },
  cleanup: { icon: HardDrive, label: 'Cleanup' },
};

export function JobsSettings() {
  const { t } = useTranslation(['notifications', 'pages', 'common']);
  const [jobs, setJobs] = useState<JobDefinition[]>([]);
  const [isLoadingJobs, setIsLoadingJobs] = useState(true);
  const [history, setHistory] = useState<JobHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [progress, setProgress] = useState<MaintenanceJobProgress | null>(null);
  const [confirmJob, setConfirmJob] = useState<JobDefinition | null>(null);
  const [jobOptions, setJobOptions] = useState<Record<string, boolean>>({});
  const [activeCategory, setActiveCategory] = useState<JobCategory>('normalization');
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const { socket } = useSocket();

  const filteredJobs = useMemo(
    () => jobs.filter((job) => job.category === activeCategory),
    [jobs, activeCategory]
  );

  // Reset options when confirm dialog opens
  const openConfirmDialog = useCallback((job: JobDefinition) => {
    // Initialize options with defaults
    const defaults: Record<string, boolean> = {};
    job.options?.forEach((opt) => {
      if (opt.type === 'boolean') {
        defaults[opt.name] = opt.default;
      }
    });
    setJobOptions(defaults);
    setConfirmJob(job);
  }, []);

  // Fetch available jobs
  useEffect(() => {
    const fetchJobs = async () => {
      try {
        const result = await api.maintenance.getJobs();
        setJobs(result.jobs);
      } catch (err) {
        console.error('Failed to fetch jobs:', err);
        toast.error(t('toast.error.jobLoadFailed'));
      } finally {
        setIsLoadingJobs(false);
      }
    };

    void fetchJobs();
  }, []);

  // Fetch job history
  const fetchHistory = useCallback(async () => {
    try {
      const result = await api.maintenance.getHistory();
      setHistory(result.history);
    } catch (err) {
      console.error('Failed to fetch job history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    void fetchHistory();
  }, []);

  // Fetch queue stats
  const fetchQueueStats = useCallback(async () => {
    try {
      const stats = await api.maintenance.getStats();
      setQueueStats(stats);
    } catch (err) {
      console.error('Failed to fetch queue stats:', err);
    }
  }, []);

  useEffect(() => {
    void fetchQueueStats();
    // Refresh stats every 10 seconds while on the page
    const interval = setInterval(() => void fetchQueueStats(), 10000);
    return () => clearInterval(interval);
  }, [fetchQueueStats]);

  // Check for active job on mount
  useEffect(() => {
    const checkActiveJob = async () => {
      try {
        const result = await api.maintenance.getProgress();
        if (result.progress) {
          const progressData = result.progress as MaintenanceJobProgress;
          setProgress(progressData);
          // Set as running if status is 'running' or 'waiting'
          if (progressData.status === 'running' || progressData.status === 'waiting') {
            setRunningJob(progressData.type);
          }
        }
      } catch (err) {
        console.error('Failed to check active job:', err);
      }
    };

    void checkActiveJob();
  }, []);

  // Listen for progress updates via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleProgress = (data: MaintenanceJobProgress) => {
      setProgress(data);
      setRunningJob(data.status === 'running' || data.status === 'waiting' ? data.type : null);

      if (data.status === 'complete') {
        toast.success(t('toast.success.jobCompleted.title'), {
          description: data.message,
        });
        void fetchHistory();
        void fetchQueueStats();
        setRunningJob(null);
      } else if (data.status === 'error') {
        toast.warning(t('toast.warning.jobFailed.title'), {
          description: data.message,
        });
        void fetchQueueStats();
        setRunningJob(null);
      }
    };

    socket.on('maintenance:progress', handleProgress);
    return () => {
      socket.off('maintenance:progress', handleProgress);
    };
  }, [socket, fetchHistory, fetchQueueStats]);

  const handleStartJob = async (type: string, options?: Record<string, boolean>) => {
    setConfirmJob(null);
    setRunningJob(type);
    setProgress({
      type: type as MaintenanceJobProgress['type'],
      status: 'running',
      totalRecords: 0,
      processedRecords: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      message: 'Starting job...',
    });

    try {
      // Only pass options if there are any truthy values
      const hasOptions = options && Object.values(options).some(Boolean);
      await api.maintenance.startJob(type, hasOptions ? options : undefined);
    } catch (err) {
      setRunningJob(null);
      setProgress(null);
      if (err instanceof Error && err.message.includes('already in progress')) {
        toast.error(t('toast.error.jobAlreadyRunning'));
      } else {
        toast.error(t('toast.error.jobStartFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    }
  };

  const getProgressPercent = () => {
    if (!progress || progress.totalRecords === 0) return 0;
    return Math.round((progress.processedRecords / progress.totalRecords) * 100);
  };

  if (isLoadingJobs) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-28 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Queue Status Banner */}
      {queueStats &&
        (queueStats.active > 0 || queueStats.waiting > 0 || queueStats.delayed > 0) && (
          <div className="border-primary/20 bg-primary/5 flex items-center gap-4 rounded-lg border px-4 py-3">
            <Activity className="text-primary h-5 w-5" />
            <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {queueStats.active > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                    <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
                  </span>
                  <span className="font-medium">{queueStats.active}</span>
                  <span className="text-muted-foreground">running</span>
                </span>
              )}
              {queueStats.waiting > 0 && (
                <span className="flex items-center gap-1.5">
                  <ListTodo className="text-muted-foreground h-3.5 w-3.5" />
                  <span className="font-medium">{queueStats.waiting}</span>
                  <span className="text-muted-foreground">queued</span>
                </span>
              )}
              {queueStats.delayed > 0 && (
                <span className="flex items-center gap-1.5">
                  <Clock className="text-muted-foreground h-3.5 w-3.5" />
                  <span className="font-medium">{queueStats.delayed}</span>
                  <span className="text-muted-foreground">delayed</span>
                </span>
              )}
            </div>
          </div>
        )}

      {/* Available Jobs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            Maintenance Jobs
          </CardTitle>
          <CardDescription>
            Run maintenance tasks to update historical data or optimize the database
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs
            value={activeCategory}
            onValueChange={(v) => setActiveCategory(v as JobCategory)}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-3">
              {(Object.keys(CATEGORY_CONFIG) as JobCategory[]).map((category) => {
                const config = CATEGORY_CONFIG[category];
                const CategoryIcon = config.icon;
                const jobCount = jobs.filter((j) => j.category === category).length;
                return (
                  <TabsTrigger key={category} value={category} className="gap-1.5">
                    <CategoryIcon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{config.label}</span>
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                      {jobCount}
                    </Badge>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

          {filteredJobs.map((job) => {
            const JobIcon = JOB_ICONS[job.type] || Wrench;
            const isRunning = runningJob === job.type;

            return (
              <div
                key={job.type}
                className={cn(
                  'rounded-lg border p-4 transition-colors',
                  isRunning && 'border-primary/30 bg-primary/5'
                )}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex gap-3">
                    <div
                      className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                        isRunning ? 'bg-primary/10' : 'bg-muted'
                      )}
                    >
                      <JobIcon
                        className={cn(
                          'h-5 w-5',
                          isRunning ? 'text-primary' : 'text-muted-foreground'
                        )}
                      />
                    </div>
                    <div className="space-y-1">
                      <h3 className="leading-none font-medium">{job.name}</h3>
                      <p className="text-muted-foreground text-sm">{job.description}</p>
                    </div>
                  </div>
                  <Button
                    onClick={() => openConfirmDialog(job)}
                    disabled={runningJob !== null}
                    size="sm"
                    className="shrink-0 self-start sm:self-center"
                  >
                    {isRunning ? (
                      progress?.status === 'waiting' ? (
                        <>
                          <Clock className="mr-1.5 h-3.5 w-3.5 animate-pulse" />
                          Waiting
                        </>
                      ) : (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          Running
                        </>
                      )
                    ) : (
                      <>
                        <Play className="mr-1.5 h-3.5 w-3.5" />
                        Run Job
                      </>
                    )}
                  </Button>
                </div>

                {/* Inline Progress for Running Job */}
                {isRunning && progress?.status === 'running' && (
                  <div className="mt-4 space-y-3 border-t pt-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{progress.message}</span>
                      <span className="font-medium tabular-nums">{getProgressPercent()}%</span>
                    </div>
                    <Progress value={getProgressPercent()} className="h-1.5" />
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span className="text-muted-foreground">
                        <span className="text-foreground font-medium">
                          {progress.processedRecords.toLocaleString()}
                        </span>{' '}
                        / {progress.totalRecords.toLocaleString()} processed
                      </span>
                      {progress.updatedRecords > 0 && (
                        <span className="text-muted-foreground">
                          <span className="font-medium text-green-600">
                            {progress.updatedRecords.toLocaleString()}
                          </span>{' '}
                          updated
                        </span>
                      )}
                      {progress.skippedRecords > 0 && (
                        <span className="text-muted-foreground">
                          <span className="font-medium">
                            {progress.skippedRecords.toLocaleString()}
                          </span>{' '}
                          unchanged
                        </span>
                      )}
                      {progress.errorRecords > 0 && (
                        <span className="text-destructive">
                          <span className="font-medium">
                            {progress.errorRecords.toLocaleString()}
                          </span>{' '}
                          errors
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Inline Waiting Status */}
                {isRunning && progress?.status === 'waiting' && (
                  <div className="mt-4 border-t pt-4">
                    <div className="flex items-center gap-2 text-sm">
                      <Clock className="text-muted-foreground h-4 w-4 animate-pulse" />
                      <span className="text-muted-foreground">{progress.message}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Completed Status Toast Area */}
          {progress?.status === 'complete' && !runningJob && (
            <div className="flex items-start gap-3 rounded-lg border border-green-500/20 bg-green-500/5 p-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-green-600">
                  Last job completed successfully
                </p>
                <p className="text-muted-foreground text-xs break-words">{progress.message}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2"
                onClick={() => setProgress(null)}
              >
                Dismiss
              </Button>
            </div>
          )}

          {progress?.status === 'error' && !runningJob && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-red-600">Last job failed</p>
                <p className="text-muted-foreground text-xs break-words">{progress.message}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2"
                onClick={() => setProgress(null)}
              >
                Dismiss
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Job History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Job History
              </CardTitle>
              <CardDescription>Recent maintenance job executions</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsLoadingHistory(true);
                void fetchHistory();
              }}
              disabled={isLoadingHistory}
              className="text-muted-foreground hover:text-foreground gap-1.5"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isLoadingHistory && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingHistory ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className="flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed">
              <ArrowUpDown className="text-muted-foreground h-4 w-4" />
              <p className="text-muted-foreground text-xs">{t('common:empty.noJobHistory')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((item) => {
                const _JobIcon = JOB_ICONS[item.type] || Wrench;
                const isSuccess = item.state === 'completed';

                return (
                  <div
                    key={item.jobId}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3',
                      !isSuccess && 'border-red-500/20 bg-red-500/5'
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                        isSuccess ? 'bg-green-500/10' : 'bg-red-500/10'
                      )}
                    >
                      {isSuccess ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-600" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium capitalize">
                          {item.type.replace(/_/g, ' ')}
                        </span>
                        <Badge
                          variant={isSuccess ? 'secondary' : 'destructive'}
                          className="text-[10px]"
                        >
                          {isSuccess ? 'Completed' : 'Failed'}
                        </Badge>
                      </div>
                      {item.result && (
                        <p className="text-muted-foreground mt-0.5 truncate text-xs">
                          {item.result.processed.toLocaleString()} processed
                          {item.result.updated > 0 &&
                            ` · ${item.result.updated.toLocaleString()} updated`}
                          {item.result.errors > 0 && (
                            <span className="text-destructive">
                              {' '}
                              · {item.result.errors.toLocaleString()} errors
                            </span>
                          )}
                        </p>
                      )}
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-muted-foreground text-xs">
                        {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                      </p>
                      {item.result && (
                        <p className="text-muted-foreground text-xs tabular-nums">
                          {formatDuration(item.result.durationMs, { style: 'compact' })}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <Dialog open={!!confirmJob} onOpenChange={() => setConfirmJob(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Run {confirmJob?.name}?</DialogTitle>
            <DialogDescription className="text-sm">{confirmJob?.description}</DialogDescription>
          </DialogHeader>

          {/* Job-specific options */}
          {confirmJob?.options && confirmJob.options.length > 0 && (
            <div className="space-y-3">
              {confirmJob.options.map((opt) => (
                <div key={opt.name} className="flex items-start gap-3 rounded-lg border p-3">
                  <Checkbox
                    id={`option-${opt.name}`}
                    checked={jobOptions[opt.name] ?? opt.default}
                    onCheckedChange={(checked) =>
                      setJobOptions((prev) => ({ ...prev, [opt.name]: checked === true }))
                    }
                  />
                  <div className="flex-1 space-y-1">
                    <Label
                      htmlFor={`option-${opt.name}`}
                      className="cursor-pointer text-sm leading-none font-medium"
                    >
                      {opt.label}
                    </Label>
                    <p className="text-muted-foreground text-xs">{opt.description}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium text-amber-600">This may take a while</p>
              <p className="text-muted-foreground mt-1 text-xs">
                The job will process all historical sessions. Progress is shown in real-time and you
                can safely navigate away.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmJob(null)}>
              Cancel
            </Button>
            <Button onClick={() => confirmJob && handleStartJob(confirmJob.type, jobOptions)}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Start Job
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
