import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  Trash2,
  RotateCcw,
  Database,
  Server,
  Users,
  Film,
  Shield,
  RefreshCw,
  Info,
  FileText,
  Scale,
  XSquare,
  Library,
  Link2,
  Camera,
  Loader2,
  Smartphone,
} from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useVersion } from '@/hooks/queries';
import { tokenStorage, api, BASE_URL } from '@/lib/api';
import { debugFetch } from '@/lib/debugFetch';
import { TasksTab } from '@/components/debug/TasksTab';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

interface DebugStats {
  counts: {
    sessions: number;
    violations: number;
    users: number;
    servers: number;
    rules: number;
    terminationLogs: number;
    libraryItems: number;
    plexAccounts: number;
  };
  database: {
    size: string;
    tables: { table_name: string; total_size: string }[];
    aggregates: { table_name: string; total_size: string }[];
  };
}

interface EnvInfo {
  nodeVersion: string;
  platform: string;
  arch: string;
  uptime: number;
  memoryUsage: {
    heapUsed: string;
    heapTotal: string;
    rss: string;
  };
  env: Record<string, string>;
}

interface LogFileInfo {
  name: string;
  exists: boolean;
}

interface LogListResponse {
  files: LogFileInfo[];
}

interface LogEntriesResponse {
  entries: string[];
  truncated: boolean;
  fileExists: boolean;
}

const MAX_LOG_LIMIT = 1000;
const LOG_LIMIT_STEP = 200;

const formatLogLabel = (name: string) => name.replace('.log', '').replace(/-/g, ' ');

interface SnapshotItem {
  id: string;
  server_id: string;
  server_name: string | null;
  library_id: string;
  library_type: string;
  snapshot_time: string;
  item_count: number;
  total_size: string;
  movie_count: number;
  episode_count: number;
  music_count: number;
  is_suspicious: boolean;
}

const formatBytes = (bytes: string | number) => {
  const num = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
  if (num === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(num) / Math.log(k));
  return `${parseFloat((num / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const NON_SUPERVISED_MESSAGE =
  "You're running Tracearr in non-supervised mode. Log explorer is not available. " +
  'Logs can be viewed by inspecting each container directly (for example, docker logs <container_name>).';

export function Debug() {
  const queryClient = useQueryClient();
  const version = useVersion();
  const isSupervised = Boolean(version.data?.current.tag?.toLowerCase().includes('supervised'));

  const stats = useQuery({
    queryKey: ['debug', 'stats'],
    queryFn: () => debugFetch<DebugStats>('/stats'),
  });

  const envInfo = useQuery({
    queryKey: ['debug', 'env'],
    queryFn: () => debugFetch<EnvInfo>('/env'),
  });

  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [logLimit, setLogLimit] = useState(LOG_LIMIT_STEP);

  const logFiles = useQuery({
    queryKey: ['debug', 'logs'],
    queryFn: () => debugFetch<LogListResponse>('/logs'),
    enabled: isSupervised,
  });

  const logEntries = useQuery({
    queryKey: ['debug', 'logs', selectedLog, logLimit],
    queryFn: () =>
      debugFetch<LogEntriesResponse>(
        `/logs/${encodeURIComponent(selectedLog ?? '')}?limit=${logLimit}`
      ),
    enabled: isSupervised && Boolean(selectedLog),
  });

  useEffect(() => {
    if (!selectedLog && logFiles.data?.files.length) {
      setSelectedLog(logFiles.data.files[0]?.name ?? null);
    }
  }, [selectedLog, logFiles.data?.files]);

  const deleteMutation = useMutation({
    mutationFn: async ({ action, isPost }: { action: string; isPost?: boolean }) => {
      return debugFetch(`/${action}`, { method: isPost ? 'POST' : 'DELETE' });
    },
    onSuccess: (_data, variables) => {
      // Factory reset: clear tokens and redirect to login
      if (variables.action === 'reset') {
        tokenStorage.clearTokens(true);
        window.location.href = `${BASE_URL}login`;
        return;
      }
      void queryClient.invalidateQueries();
    },
  });

  const handleDelete = (action: string, description: string, isPost = false) => {
    if (window.confirm(`${description}\n\nThis cannot be undone. Continue?`)) {
      deleteMutation.mutate({ action, isPost });
    }
  };

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const handleLogsRefresh = () => {
    void logFiles.refetch();
    void logEntries.refetch();
  };

  // Snapshot management state
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);
  const [showSuspiciousOnly, setShowSuspiciousOnly] = useState(true);
  const [selectedSnapshots, setSelectedSnapshots] = useState<Set<string>>(new Set());
  const [isDeletingSnapshots, setIsDeletingSnapshots] = useState(false);
  const [confirmDeleteSnapshots, setConfirmDeleteSnapshots] = useState(false);

  const fetchSnapshots = useCallback(async () => {
    setIsLoadingSnapshots(true);
    try {
      const result = await api.maintenance.getSnapshots({
        suspicious: showSuspiciousOnly || undefined,
      });
      setSnapshots(result.snapshots);
      setSelectedSnapshots(new Set());
    } catch (err) {
      console.error('Failed to fetch snapshots:', err);
      toast.error('Failed to load snapshots');
    } finally {
      setIsLoadingSnapshots(false);
    }
  }, [showSuspiciousOnly]);

  const handleDeleteSelectedSnapshots = async () => {
    if (selectedSnapshots.size === 0) return;
    setIsDeletingSnapshots(true);
    setConfirmDeleteSnapshots(false);

    try {
      const result = await api.maintenance.deleteSnapshots({
        ids: Array.from(selectedSnapshots),
      });
      toast.success(`Deleted ${result.deleted} snapshot(s)`);
      void fetchSnapshots();
    } catch (err) {
      console.error('Failed to delete snapshots:', err);
      toast.error('Failed to delete snapshots');
    } finally {
      setIsDeletingSnapshots(false);
    }
  };

  const handleDeleteAllSuspicious = async () => {
    setIsDeletingSnapshots(true);
    setConfirmDeleteSnapshots(false);

    try {
      const result = await api.maintenance.deleteSnapshots({
        criteria: { suspicious: true },
      });
      toast.success(`Deleted ${result.deleted} suspicious snapshot(s)`);
      void fetchSnapshots();
    } catch (err) {
      console.error('Failed to delete snapshots:', err);
      toast.error('Failed to delete snapshots');
    } finally {
      setIsDeletingSnapshots(false);
    }
  };

  const toggleSnapshotSelection = (id: string) => {
    setSelectedSnapshots((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const _toggleAllSnapshots = () => {
    if (selectedSnapshots.size === snapshots.length) {
      setSelectedSnapshots(new Set());
    } else {
      setSelectedSnapshots(new Set(snapshots.map((s) => s.id)));
    }
  };

  const handlePageSelect = (rows: SnapshotItem[]) => {
    const pageIds = new Set(rows.map((r) => r.id));
    const allSelected = rows.every((r) => selectedSnapshots.has(r.id));
    if (allSelected) {
      setSelectedSnapshots((prev) => {
        const next = new Set(prev);
        pageIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedSnapshots((prev) => new Set([...prev, ...pageIds]));
    }
  };

  const snapshotColumns: ColumnDef<SnapshotItem>[] = useMemo(
    () => [
      {
        accessorKey: 'snapshot_time',
        header: 'Date',
        cell: ({ row }) => {
          const date = new Date(row.original.snapshot_time);
          return (
            <div className="text-xs">
              <div>{format(date, 'MMM d, yyyy')}</div>
              <div className="text-muted-foreground">
                {formatDistanceToNow(date, { addSuffix: true })}
              </div>
            </div>
          );
        },
        sortingFn: 'datetime',
      },
      {
        accessorKey: 'server_name',
        header: 'Server',
        cell: ({ row }) => <span className="text-xs">{row.original.server_name || 'Unknown'}</span>,
      },
      {
        accessorKey: 'library_type',
        header: 'Library',
        cell: ({ row }) => (
          <Badge variant="secondary" className="text-xs font-normal">
            {row.original.library_type}
          </Badge>
        ),
      },
      {
        accessorKey: 'is_suspicious',
        header: 'Status',
        cell: ({ row }) =>
          row.original.is_suspicious ? (
            <Badge variant="outline" className="border-amber-500/30 text-xs text-amber-600">
              Suspicious
            </Badge>
          ) : (
            <span className="text-muted-foreground text-xs">OK</span>
          ),
      },
      {
        accessorKey: 'item_count',
        header: 'Items',
        cell: ({ row }) => (
          <span className="text-xs">{row.original.item_count.toLocaleString()}</span>
        ),
      },
      {
        accessorKey: 'total_size',
        header: 'Size',
        cell: ({ row }) => <span className="text-xs">{formatBytes(row.original.total_size)}</span>,
        sortingFn: (rowA, rowB) => {
          const a = parseInt(String(rowA.original.total_size), 10) || 0;
          const b = parseInt(String(rowB.original.total_size), 10) || 0;
          return a - b;
        },
      },
      {
        id: 'content',
        header: 'Content',
        cell: ({ row }) => {
          const { movie_count, episode_count, music_count } = row.original;
          const parts: string[] = [];
          if (movie_count > 0) parts.push(`${movie_count} movies`);
          if (episode_count > 0) parts.push(`${episode_count} episodes`);
          if (music_count > 0) parts.push(`${music_count} tracks`);
          return <span className="text-muted-foreground text-xs">{parts.join(', ') || '—'}</span>;
        },
        enableSorting: false,
      },
    ],
    []
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="bg-destructive/10 flex h-10 w-10 items-center justify-center rounded-lg">
          <AlertTriangle className="text-destructive h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Debug Tools</h1>
          <p className="text-muted-foreground text-sm">
            Administrative utilities for troubleshooting and data management
          </p>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="snapshots">Library Snapshots</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          {/* Stats Overview */}
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Film className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.sessions ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">Sessions</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Shield className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.violations ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">Violations</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Scale className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.rules ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">Rules</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Users className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.users ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">Users</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Server className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.servers ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">Servers</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Link2 className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.plexAccounts ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">Plex Accounts</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <XSquare className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.terminationLogs ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">Terminations</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Library className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.libraryItems ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">Library Items</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Database className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.database.size ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">DB Size</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Environment Info - Full Width */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info className="h-5 w-5" />
                Environment
              </CardTitle>
              <CardDescription>Server runtime information</CardDescription>
            </CardHeader>
            <CardContent>
              {envInfo.data && (
                <div className="grid gap-6 lg:grid-cols-2">
                  {/* Runtime Info */}
                  <div>
                    <p className="mb-3 text-sm font-medium">Runtime</p>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="text-muted-foreground">Node.js</div>
                      <div className="font-mono">{envInfo.data.nodeVersion}</div>
                      <div className="text-muted-foreground">Platform</div>
                      <div className="font-mono">
                        {envInfo.data.platform}/{envInfo.data.arch}
                      </div>
                      <div className="text-muted-foreground">Uptime</div>
                      <div className="font-mono">{formatUptime(envInfo.data.uptime)}</div>
                      <div className="text-muted-foreground">Heap Used</div>
                      <div className="font-mono">{envInfo.data.memoryUsage.heapUsed}</div>
                      <div className="text-muted-foreground">RSS</div>
                      <div className="font-mono">{envInfo.data.memoryUsage.rss}</div>
                    </div>
                  </div>
                  {/* Environment Variables */}
                  <div>
                    <p className="mb-3 text-sm font-medium">Environment Variables</p>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      {Object.entries(envInfo.data.env).map(([key, value]) => (
                        <div key={key} className="contents">
                          <div className="text-muted-foreground truncate">{key}</div>
                          <div className="font-mono text-xs">{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Table Sizes - Full Width */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Database Storage
              </CardTitle>
              <CardDescription>
                Storage usage by table type ({stats.data?.database.size ?? '-'} total)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 lg:grid-cols-2">
                {/* Application Tables */}
                <div>
                  <p className="mb-3 text-sm font-medium">Application Tables</p>
                  <div className="space-y-1.5">
                    {stats.data?.database.tables.map((table) => (
                      <div
                        key={table.table_name}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="text-muted-foreground font-mono text-xs">
                          {table.table_name}
                        </span>
                        <span className="font-mono text-xs">{table.total_size}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Continuous Aggregates */}
                <div>
                  <p className="mb-3 text-sm font-medium">Continuous Aggregates</p>
                  <div className="space-y-1.5">
                    {stats.data?.database.aggregates?.length ? (
                      stats.data.database.aggregates.map((table) => (
                        <div
                          key={table.table_name}
                          className="flex items-center justify-between text-sm"
                        >
                          <span className="text-muted-foreground font-mono text-xs">
                            {table.table_name}
                          </span>
                          <span className="font-mono text-xs">{table.total_size}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-muted-foreground text-xs">No continuous aggregates</p>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trash2 className="h-5 w-5" />
                Data Management
              </CardTitle>
              <CardDescription>Clear data or reset the application</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Utility Actions */}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    handleDelete('refresh-aggregates', 'Refresh TimescaleDB aggregates', true)
                  }
                  disabled={deleteMutation.isPending}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh Aggregates
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    handleDelete('clear-stuck-jobs', 'Clear stuck maintenance jobs', true)
                  }
                  disabled={deleteMutation.isPending}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Clear Stuck Jobs
                </Button>
                <Button
                  variant="outline"
                  className="border-destructive/50 text-destructive hover:bg-destructive/10"
                  onClick={() =>
                    handleDelete(
                      'obliterate-all-jobs',
                      'OBLITERATE ALL JOBS: This will completely wipe ALL job queues (maintenance, import, library sync) and release all locks. Use only when jobs are completely stuck.',
                      true
                    )
                  }
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Obliterate All Jobs
                </Button>
                <Button variant="outline" onClick={() => queryClient.invalidateQueries()}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Clear Query Cache
                </Button>
                <Button
                  variant="outline"
                  className="border-destructive/50 text-destructive hover:bg-destructive/10"
                  onClick={() =>
                    handleDelete(
                      'mobile',
                      'Delete all mobile pairing codes and paired devices. Active devices will be disconnected.'
                    )
                  }
                  disabled={deleteMutation.isPending}
                >
                  <Smartphone className="mr-2 h-4 w-4" />
                  Clear Mobile Devices
                </Button>
              </div>

              <div className="border-t pt-4">
                <p className="text-muted-foreground mb-3 text-sm font-medium">
                  Destructive Actions
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => handleDelete('violations', 'Delete all violation records')}
                    disabled={deleteMutation.isPending}
                  >
                    Clear Violations
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      handleDelete('rules', 'Delete all detection rules and violations')
                    }
                    disabled={deleteMutation.isPending}
                  >
                    Clear Rules
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      handleDelete('termination-logs', 'Delete all stream termination logs')
                    }
                    disabled={deleteMutation.isPending}
                  >
                    Clear Termination Logs
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      handleDelete(
                        'library',
                        'Delete all library metadata cache (items and snapshots)'
                      )
                    }
                    disabled={deleteMutation.isPending}
                  >
                    Clear Library Cache
                  </Button>
                  <Button
                    variant="outline"
                    className="border-destructive/50 text-destructive hover:bg-destructive/10"
                    onClick={() =>
                      handleDelete(
                        'sessions',
                        'Delete all session history, violations, and termination logs'
                      )
                    }
                    disabled={deleteMutation.isPending}
                  >
                    Clear Sessions
                  </Button>
                  <Button
                    variant="outline"
                    className="border-destructive/50 text-destructive hover:bg-destructive/10"
                    onClick={() =>
                      handleDelete('users', 'Delete all non-owner users and their data')
                    }
                    disabled={deleteMutation.isPending}
                  >
                    Clear Users
                  </Button>
                  <Button
                    variant="outline"
                    className="border-destructive/50 text-destructive hover:bg-destructive/10"
                    onClick={() =>
                      handleDelete(
                        'servers',
                        'Delete all servers (cascades to users, sessions, violations, library data)'
                      )
                    }
                    disabled={deleteMutation.isPending}
                  >
                    Clear Servers
                  </Button>
                </div>
              </div>

              <div className="border-t pt-4">
                <Button
                  variant="destructive"
                  onClick={() =>
                    handleDelete(
                      'reset',
                      'FACTORY RESET: Delete everything except your owner account. You will need to set up the app again.',
                      true
                    )
                  }
                  disabled={deleteMutation.isPending}
                >
                  <AlertTriangle className="mr-2 h-4 w-4" />
                  Factory Reset
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="snapshots" className="space-y-6">
          {/* Snapshot Management */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Camera className="h-5 w-5" />
                    Library Snapshots
                  </CardTitle>
                  <CardDescription>
                    Manage library snapshots used for Storage Trend and Quality Evolution charts
                  </CardDescription>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="suspicious-only"
                      checked={showSuspiciousOnly}
                      onCheckedChange={setShowSuspiciousOnly}
                    />
                    <Label htmlFor="suspicious-only" className="text-sm">
                      Suspicious only
                    </Label>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void fetchSnapshots()}
                    disabled={isLoadingSnapshots}
                    className="gap-1.5"
                  >
                    <RefreshCw
                      className={cn('h-3.5 w-3.5', isLoadingSnapshots && 'animate-spin')}
                    />
                    Load
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {snapshots.length === 0 && !isLoadingSnapshots ? (
                <div className="flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed">
                  <Camera className="text-muted-foreground h-4 w-4" />
                  <p className="text-muted-foreground text-xs">
                    {showSuspiciousOnly
                      ? 'No suspicious snapshots found'
                      : 'Click "Load" to view snapshots'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Actions bar */}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground text-sm">
                      {selectedSnapshots.size > 0
                        ? `${selectedSnapshots.size} of ${snapshots.length} selected`
                        : `${snapshots.length} snapshot(s)`}
                    </span>
                    <div className="flex gap-2">
                      {selectedSnapshots.size > 0 && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setConfirmDeleteSnapshots(true)}
                          disabled={isDeletingSnapshots}
                        >
                          {isDeletingSnapshots ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          Delete Selected
                        </Button>
                      )}
                      {showSuspiciousOnly &&
                        snapshots.length > 0 &&
                        selectedSnapshots.size === 0 && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setConfirmDeleteSnapshots(true)}
                            disabled={isDeletingSnapshots}
                          >
                            {isDeletingSnapshots ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            Delete All Suspicious
                          </Button>
                        )}
                    </div>
                  </div>

                  {/* Snapshot table */}
                  <DataTable
                    columns={snapshotColumns}
                    data={snapshots}
                    pageSize={50}
                    compact
                    isLoading={isLoadingSnapshots}
                    emptyMessage={
                      showSuspiciousOnly
                        ? 'No suspicious snapshots found'
                        : 'Click "Load" to view snapshots'
                    }
                    selectable
                    getRowId={(row) => row.id}
                    selectedIds={selectedSnapshots}
                    onRowSelect={(row) => toggleSnapshotSelection(row.id)}
                    onPageSelect={handlePageSelect}
                    isPageSelected={
                      snapshots.length > 0 && snapshots.every((s) => selectedSnapshots.has(s.id))
                    }
                    isPageIndeterminate={
                      selectedSnapshots.size > 0 && selectedSnapshots.size < snapshots.length
                    }
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Info Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info className="h-5 w-5" />
                About Snapshots
              </CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground space-y-2 text-sm">
              <p>
                Library snapshots are point-in-time records of your library's state. They power the
                Storage Trend and Quality Evolution charts.
              </p>
              <p>
                <strong className="text-foreground">Suspicious snapshots</strong> have 0 bytes total
                size but contain video content - this usually indicates an incomplete sync where
                episodes/tracks weren't fetched properly.
              </p>
              <p>
                Deleting bad snapshots allows the backfill job to recreate them correctly from your
                library items' created_at dates.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tasks" className="space-y-6">
          <TasksTab />
        </TabsContent>

        <TabsContent value="logs" className="space-y-6">
          {/* Log Explorer */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Log Explorer
              </CardTitle>
              <CardDescription>Supervised deployment logs</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {version.isLoading ? (
                <div className="text-muted-foreground text-sm">Checking deployment mode...</div>
              ) : !isSupervised ? (
                <div className="text-muted-foreground text-sm">{NON_SUPERVISED_MESSAGE}</div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={handleLogsRefresh}
                      disabled={logFiles.isFetching || logEntries.isFetching}
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      Refresh Logs
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setLogLimit((prev) => Math.min(prev + LOG_LIMIT_STEP, MAX_LOG_LIMIT))
                      }
                      disabled={logEntries.isFetching || logLimit >= MAX_LOG_LIMIT}
                    >
                      Load More
                    </Button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {logFiles.data?.files.map((file) => (
                      <Button
                        key={file.name}
                        size="sm"
                        variant={selectedLog === file.name ? 'default' : 'outline'}
                        onClick={() => setSelectedLog(file.name)}
                      >
                        {formatLogLabel(file.name)}
                      </Button>
                    ))}
                  </div>

                  {selectedLog && logEntries.isLoading ? (
                    <div className="text-muted-foreground text-sm">Loading log entries...</div>
                  ) : selectedLog && !logEntries.data?.fileExists ? (
                    <div className="text-muted-foreground text-sm">Log file not found.</div>
                  ) : logEntries.data?.entries.length ? (
                    <div className="bg-muted/30 max-h-[420px] overflow-y-auto rounded-md border p-3">
                      <pre className="font-mono text-xs break-words whitespace-pre-wrap">
                        {logEntries.data.entries.join('\n')}
                      </pre>
                    </div>
                  ) : (
                    <div className="text-muted-foreground text-sm">No logs available yet.</div>
                  )}

                  {logEntries.data?.truncated && (
                    <div className="text-muted-foreground text-xs">
                      Showing the most recent entries. Increase the limit to see more history.
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Delete Snapshots Confirmation Dialog */}
      <Dialog open={confirmDeleteSnapshots} onOpenChange={setConfirmDeleteSnapshots}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Snapshots?</DialogTitle>
            <DialogDescription className="text-sm">
              {selectedSnapshots.size > 0
                ? `This will delete ${selectedSnapshots.size} selected snapshot(s).`
                : 'This will delete all suspicious snapshots (those with 0 bytes for video libraries).'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium text-amber-600">This cannot be undone</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Deleted snapshots will need to be recreated via the Backfill Library Snapshots job.
                The continuous aggregate will be refreshed automatically.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDeleteSnapshots(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={
                selectedSnapshots.size > 0
                  ? handleDeleteSelectedSnapshots
                  : handleDeleteAllSuspicious
              }
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
