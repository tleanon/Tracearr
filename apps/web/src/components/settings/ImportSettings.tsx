import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Server as ServerIcon,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Upload,
  Info,
} from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { ImportProgressCard, FileDropzone, type ImportProgressData } from '@/components/import';
import type { Server, TautulliImportProgress, JellystatImportProgress } from '@tracearr/shared';
import { useSettings, useUpdateSettings, useServers } from '@/hooks/queries';

// Tautulli Import Section Component
interface TautulliImportSectionProps {
  tautulliUrl: string;
  setTautulliUrl: (url: string) => void;
  tautulliApiKey: string;
  setTautulliApiKey: (key: string) => void;
  connectionStatus: 'idle' | 'testing' | 'success' | 'error';
  connectionMessage: string;
  handleTestConnection: () => Promise<void>;
  plexServers: Server[];
  selectedPlexServerId: string;
  setSelectedPlexServerId: (id: string) => void;
  isTautulliImporting: boolean;
  overwriteFriendlyNames: boolean;
  setOverwriteFriendlyNames: (overwrite: boolean) => void;
  includeStreamDetails: boolean;
  setIncludeStreamDetails: (include: boolean) => void;
  handleStartTautulliImport: () => Promise<void>;
  tautulliProgressData: ImportProgressData | null;
}

function TautulliImportSection({
  tautulliUrl,
  setTautulliUrl,
  tautulliApiKey,
  setTautulliApiKey,
  connectionStatus,
  connectionMessage,
  handleTestConnection,
  plexServers,
  selectedPlexServerId,
  setSelectedPlexServerId,
  isTautulliImporting,
  overwriteFriendlyNames,
  setOverwriteFriendlyNames,
  includeStreamDetails,
  setIncludeStreamDetails,
  handleStartTautulliImport,
  tautulliProgressData,
}: TautulliImportSectionProps) {
  return (
    <div className="space-y-6">
      {/* Connection Setup */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            1
          </span>
          Connect to Tautulli
        </div>

        <div className="ml-8 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tautulliUrl">Tautulli URL</Label>
            <Input
              id="tautulliUrl"
              placeholder="http://localhost:8181"
              value={tautulliUrl}
              onChange={(e) => setTautulliUrl(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              The URL where Tautulli is accessible (include port if needed)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tautulliApiKey">API Key</Label>
            <Input
              id="tautulliApiKey"
              type="password"
              placeholder="Your Tautulli API key"
              value={tautulliApiKey}
              onChange={(e) => setTautulliApiKey(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Find this in Tautulli Settings → Web Interface → API Key
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleTestConnection}
              disabled={connectionStatus === 'testing' || !tautulliUrl || !tautulliApiKey}
              variant={connectionStatus === 'success' ? 'outline' : 'default'}
            >
              {connectionStatus === 'testing' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing...
                </>
              ) : connectionStatus === 'success' ? (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Connected
                </>
              ) : (
                'Test Connection'
              )}
            </Button>

            {connectionStatus === 'success' && connectionMessage && (
              <span className="text-sm text-green-600">{connectionMessage}</span>
            )}

            {connectionStatus === 'error' && (
              <span className="text-destructive flex items-center gap-1 text-sm">
                <XCircle className="h-4 w-4" />
                {connectionMessage}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Import Section - Only shown when connected */}
      {connectionStatus === 'success' && (
        <>
          <div className="space-y-4 border-t pt-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
                2
              </span>
              Import History
            </div>

            <div className="ml-8 space-y-4">
              <div className="space-y-2">
                <Label>Target Server</Label>
                <Select value={selectedPlexServerId} onValueChange={setSelectedPlexServerId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a Plex server" />
                  </SelectTrigger>
                  <SelectContent>
                    {plexServers.map((server) => (
                      <SelectItem key={server.id} value={server.id}>
                        <div className="flex items-center gap-2">
                          <MediaServerIcon type="plex" className="h-4 w-4" />
                          {server.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="overwriteFriendlyNames"
                  checked={overwriteFriendlyNames}
                  onCheckedChange={(checked: boolean | 'indeterminate') =>
                    setOverwriteFriendlyNames(checked === true)
                  }
                  disabled={isTautulliImporting}
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="overwriteFriendlyNames"
                    className="cursor-pointer text-sm font-normal"
                  >
                    Overwrite existing friendly names with Tautulli names
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    By default, Tracearr keeps any custom names already set. Enable this to replace
                    all existing names with the ones from Tautulli.
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="includeStreamDetails"
                  checked={includeStreamDetails}
                  onCheckedChange={(checked: boolean | 'indeterminate') =>
                    setIncludeStreamDetails(checked === true)
                  }
                  disabled={isTautulliImporting}
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="includeStreamDetails"
                    className="flex cursor-pointer items-center gap-2 text-sm font-normal"
                  >
                    Include detailed stream data (codecs, bitrate, resolution)
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500">
                      BETA
                    </span>
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    Fetches additional quality data for each session via separate API calls. This
                    enables bandwidth and quality statistics but significantly increases import
                    time.
                  </p>
                </div>
              </div>

              <Button
                onClick={handleStartTautulliImport}
                disabled={!selectedPlexServerId || isTautulliImporting}
                size="lg"
              >
                {isTautulliImporting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Download className="mr-2 h-4 w-4" />
                    Start Import
                  </>
                )}
              </Button>

              {tautulliProgressData && (
                <ImportProgressCard progress={tautulliProgressData} showPageProgress />
              )}
            </div>
          </div>

          {/* Info cards */}
          <div className="space-y-3">
            <div className="bg-muted/50 flex gap-3 rounded-lg p-4">
              <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              <div className="text-muted-foreground space-y-2 text-sm">
                <p className="text-foreground font-medium">How the import works</p>
                <p>
                  Tracearr fetches your watch history from Tautulli and matches each record to
                  existing users in Tracearr by their Plex user ID.
                </p>
              </div>
            </div>

            <div className="flex gap-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
              <div className="space-y-2 text-sm">
                <p className="font-medium">Records may be skipped if:</p>
                <ul className="text-muted-foreground list-inside list-disc space-y-1">
                  <li>
                    <strong>User not found</strong> — The Plex user doesn&apos;t exist in Tracearr.
                    Sync your server first to add all users.
                  </li>
                  <li>
                    <strong>Duplicate session</strong> — The session was already imported
                    previously.
                  </li>
                  <li>
                    <strong>In-progress session</strong> — Active/incomplete sessions without a
                    reference ID are skipped.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Jellystat Import Section Component
interface JellystatImportSectionProps {
  jellyfinEmbyServers: Server[];
  selectedJellyfinServerId: string;
  setSelectedJellyfinServerId: (id: string) => void;
  selectedFile: File | null;
  handleFileSelect: (file: File | null) => void;
  enrichMedia: boolean;
  setEnrichMedia: (enrich: boolean) => void;
  updateStreamDetails: boolean;
  setUpdateStreamDetails: (update: boolean) => void;
  isJellystatImporting: boolean;
  handleStartJellystatImport: () => Promise<void>;
  jellystatProgressData: ImportProgressData | null;
}

function JellystatImportSection({
  jellyfinEmbyServers,
  selectedJellyfinServerId,
  setSelectedJellyfinServerId,
  selectedFile,
  handleFileSelect,
  enrichMedia,
  setEnrichMedia,
  updateStreamDetails,
  setUpdateStreamDetails,
  isJellystatImporting,
  handleStartJellystatImport,
  jellystatProgressData,
}: JellystatImportSectionProps) {
  return (
    <div className="space-y-6">
      {/* Server Selection */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            1
          </span>
          Select Target Server
        </div>

        <div className="ml-8 space-y-2">
          <Select value={selectedJellyfinServerId} onValueChange={setSelectedJellyfinServerId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a Jellyfin or Emby server" />
            </SelectTrigger>
            <SelectContent>
              {jellyfinEmbyServers.map((server) => (
                <SelectItem key={server.id} value={server.id}>
                  <div className="flex items-center gap-2">
                    <MediaServerIcon type={server.type} className="h-4 w-4" />
                    {server.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* File Upload */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            2
          </span>
          Upload Jellystat Backup
        </div>

        <div className="ml-8 space-y-4">
          <FileDropzone
            accept=".json"
            maxSize={500 * 1024 * 1024}
            onFileSelect={handleFileSelect}
            selectedFile={selectedFile}
            disabled={isJellystatImporting}
          />
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
            <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
              Export an Activity Backup from Jellystat
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              In Jellystat, go to Settings → Backup → select <strong>&quot;Activity&quot;</strong> →
              Export. Full backups are not supported — only the Activity backup contains the
              playback history needed for import.
            </p>
          </div>
        </div>
      </div>

      {/* Options */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            3
          </span>
          Import Options
        </div>

        <div className="ml-8 space-y-3">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="enrichMedia"
              checked={enrichMedia}
              onCheckedChange={(checked: boolean | 'indeterminate') =>
                setEnrichMedia(checked === true)
              }
              disabled={isJellystatImporting}
            />
            <div className="space-y-1">
              <Label htmlFor="enrichMedia" className="cursor-pointer text-sm font-normal">
                Enrich with media metadata (recommended)
              </Label>
              <p className="text-muted-foreground text-xs">
                Fetches season/episode numbers and artwork from your media server. Slower but
                provides better data quality.
              </p>
            </div>
          </div>
          <div className="flex items-start space-x-3">
            <Checkbox
              id="updateStreamDetails"
              checked={updateStreamDetails}
              onCheckedChange={(checked: boolean | 'indeterminate') =>
                setUpdateStreamDetails(checked === true)
              }
              disabled={isJellystatImporting}
            />
            <div className="space-y-1">
              <Label htmlFor="updateStreamDetails" className="cursor-pointer text-sm font-normal">
                Update existing records with stream details
              </Label>
              <p className="text-muted-foreground text-xs">
                Updates previously imported sessions with codec, bitrate, and transcode data from
                the backup. Use when re-importing to backfill new stream fields.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Import Button */}
      <div className="border-t pt-6">
        <Button
          onClick={handleStartJellystatImport}
          disabled={!selectedJellyfinServerId || !selectedFile || isJellystatImporting}
          size="lg"
        >
          {isJellystatImporting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Importing...
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              Start Import
            </>
          )}
        </Button>

        {jellystatProgressData && (
          <div className="mt-4">
            <ImportProgressCard progress={jellystatProgressData} />
          </div>
        )}
      </div>

      {/* Info cards */}
      <div className="space-y-3">
        <div className="bg-muted/50 flex gap-3 rounded-lg p-4">
          <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-muted-foreground space-y-2 text-sm">
            <p className="text-foreground font-medium">How the import works</p>
            <p>
              Tracearr parses the Jellystat Activity backup and matches each record to existing
              users in Tracearr by their Jellyfin/Emby user ID.
            </p>
          </div>
        </div>

        <div className="flex gap-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          <div className="space-y-2 text-sm">
            <p className="font-medium">Records may be skipped if:</p>
            <ul className="text-muted-foreground list-inside list-disc space-y-1">
              <li>
                <strong>User not found</strong> — The Jellyfin/Emby user doesn&apos;t exist in
                Tracearr. Sync your server first to add all users.
              </li>
              <li>
                <strong>Duplicate session</strong> — The session was already imported previously.
              </li>
            </ul>
            <p className="text-muted-foreground pt-1">
              If many records are skipped, ensure you&apos;ve synced your server recently in
              Settings → Servers.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ImportSettings() {
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: serversData, isLoading: serversLoading } = useServers();
  const updateSettings = useUpdateSettings();
  const { socket } = useSocket();

  // Tautulli state
  const [tautulliUrl, setTautulliUrl] = useState('');
  const [tautulliApiKey, setTautulliApiKey] = useState('');
  const [selectedPlexServerId, setSelectedPlexServerId] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [tautulliProgress, setTautulliProgress] = useState<TautulliImportProgress | null>(null);
  const [isTautulliImporting, setIsTautulliImporting] = useState(false);
  const [overwriteFriendlyNames, setOverwriteFriendlyNames] = useState(false);
  const [includeStreamDetails, setIncludeStreamDetails] = useState(false);
  const [_tautulliActiveJobId, setTautulliActiveJobId] = useState<string | null>(null);

  // Jellystat state
  const [selectedJellyfinServerId, setSelectedJellyfinServerId] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [enrichMedia, setEnrichMedia] = useState(true);
  const [updateStreamDetails, setUpdateStreamDetails] = useState(false);
  const [jellystatProgress, setJellystatProgress] = useState<JellystatImportProgress | null>(null);
  const [isJellystatImporting, setIsJellystatImporting] = useState(false);
  const [_jellystatActiveJobId, setJellystatActiveJobId] = useState<string | null>(null);

  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);

  // Split servers by type
  const plexServers = servers.filter((s) => s.type === 'plex');
  const jellyfinEmbyServers = servers.filter((s) => s.type === 'jellyfin' || s.type === 'emby');

  // Initialize form with saved settings
  useEffect(() => {
    if (settings) {
      setTautulliUrl(settings.tautulliUrl ?? '');
      setTautulliApiKey(settings.tautulliApiKey ?? '');
      if (settings.tautulliUrl && settings.tautulliApiKey) {
        setConnectionStatus('success');
      }
    }
  }, [settings]);

  // Check for active Tautulli import on mount
  useEffect(() => {
    if (plexServers.length === 0) return;

    const checkActiveImports = async () => {
      for (const server of plexServers) {
        try {
          const result = await api.import.tautulli.getActive(server.id);
          if (result.active && result.jobId) {
            setSelectedPlexServerId(server.id);
            setTautulliActiveJobId(result.jobId);
            setIsTautulliImporting(true);

            const progressPercent = typeof result.progress === 'number' ? result.progress : 0;
            setTautulliProgress({
              status: 'processing',
              totalRecords: 0,
              fetchedRecords: 0,
              processedRecords: 0,
              importedRecords: 0,
              updatedRecords: 0,
              skippedRecords: 0,
              duplicateRecords: 0,
              unknownUserRecords: 0,
              activeSessionRecords: 0,
              errorRecords: 0,
              currentPage: 0,
              totalPages: 0,
              message:
                progressPercent > 0
                  ? `Import in progress (${progressPercent}% complete)...`
                  : 'Import in progress...',
            });
            setConnectionStatus('success');
            break;
          }
        } catch {
          // Ignore errors
        }
      }
    };

    void checkActiveImports();
  }, [plexServers.length]);

  // Check for active Jellystat import on mount
  useEffect(() => {
    if (jellyfinEmbyServers.length === 0) return;

    const checkActiveJellystatImports = async () => {
      for (const server of jellyfinEmbyServers) {
        try {
          const result = await api.import.jellystat.getActive(server.id);
          if (result.active && result.jobId) {
            setSelectedJellyfinServerId(server.id);
            setJellystatActiveJobId(result.jobId);
            setIsJellystatImporting(true);

            const progressPercent = typeof result.progress === 'number' ? result.progress : 0;
            setJellystatProgress({
              status: 'processing',
              totalRecords: 0,
              processedRecords: 0,
              importedRecords: 0,
              skippedRecords: 0,
              errorRecords: 0,
              filteredRecords: 0,
              enrichedRecords: 0,
              message:
                progressPercent > 0
                  ? `Import in progress (${progressPercent}% complete)...`
                  : 'Import in progress...',
            });
            break;
          }
        } catch {
          // Ignore errors
        }
      }
    };

    void checkActiveJellystatImports();
  }, [jellyfinEmbyServers.length]);

  // Listen for Tautulli import progress via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleTautulliProgress = (progress: TautulliImportProgress) => {
      setTautulliProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error') {
        setIsTautulliImporting(false);
        setTautulliActiveJobId(null);
      }
    };

    socket.on('import:progress', handleTautulliProgress);
    return () => {
      socket.off('import:progress', handleTautulliProgress);
    };
  }, [socket]);

  // Listen for Jellystat import progress via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleJellystatProgress = (progress: JellystatImportProgress) => {
      setJellystatProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error') {
        setIsJellystatImporting(false);
        setJellystatActiveJobId(null);
        setSelectedFile(null);
      }
    };

    socket.on('import:jellystat:progress', handleJellystatProgress);
    return () => {
      socket.off('import:jellystat:progress', handleJellystatProgress);
    };
  }, [socket]);

  const handleSaveSettings = () => {
    updateSettings.mutate({
      tautulliUrl: tautulliUrl || null,
      tautulliApiKey: tautulliApiKey || null,
    });
  };

  const handleTestConnection = async () => {
    if (!tautulliUrl || !tautulliApiKey) {
      setConnectionStatus('error');
      setConnectionMessage('Please enter Tautulli URL and API key');
      return;
    }

    setConnectionStatus('testing');
    setConnectionMessage('Testing connection...');

    try {
      const result = await api.import.tautulli.test(tautulliUrl, tautulliApiKey);
      if (result.success) {
        setConnectionStatus('success');
        setConnectionMessage(
          `Connected! Found ${result.users ?? 0} users and ${(result.historyRecords ?? 0).toLocaleString()} history records.`
        );
        handleSaveSettings();
      } else {
        setConnectionStatus('error');
        setConnectionMessage(result.message || 'Connection failed');
      }
    } catch (err) {
      setConnectionStatus('error');
      setConnectionMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const handleStartTautulliImport = async () => {
    if (!selectedPlexServerId) return;

    setIsTautulliImporting(true);
    setTautulliProgress({
      status: 'fetching',
      totalRecords: 0,
      fetchedRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      duplicateRecords: 0,
      unknownUserRecords: 0,
      activeSessionRecords: 0,
      errorRecords: 0,
      currentPage: 0,
      totalPages: 0,
      message: 'Starting import...',
    });

    try {
      const result = await api.import.tautulli.start(
        selectedPlexServerId,
        overwriteFriendlyNames,
        includeStreamDetails
      );
      if (result.jobId) {
        setTautulliActiveJobId(result.jobId);
      }
    } catch (err) {
      setIsTautulliImporting(false);
      setTautulliActiveJobId(null);
      setTautulliProgress({
        status: 'error',
        totalRecords: 0,
        fetchedRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        updatedRecords: 0,
        skippedRecords: 0,
        duplicateRecords: 0,
        unknownUserRecords: 0,
        activeSessionRecords: 0,
        errorRecords: 0,
        currentPage: 0,
        totalPages: 0,
        message: err instanceof Error ? err.message : 'Import failed',
      });
    }
  };

  const handleFileSelect = (file: File | null) => {
    if (file && !file.name.endsWith('.json')) {
      setJellystatProgress({
        status: 'error',
        totalRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        skippedRecords: 0,
        errorRecords: 0,
        filteredRecords: 0,
        enrichedRecords: 0,
        message: 'Please select a JSON file',
      });
      return;
    }
    setSelectedFile(file);
    if (file) {
      setJellystatProgress(null);
    }
  };

  const handleStartJellystatImport = async () => {
    if (!selectedJellyfinServerId || !selectedFile) return;

    setIsJellystatImporting(true);
    setJellystatProgress({
      status: 'processing',
      totalRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      filteredRecords: 0,
      enrichedRecords: 0,
      message: 'Uploading backup file...',
    });

    try {
      const result = await api.import.jellystat.start(
        selectedJellyfinServerId,
        selectedFile,
        enrichMedia,
        updateStreamDetails
      );
      if (result.jobId) {
        setJellystatActiveJobId(result.jobId);
      }
    } catch (err) {
      setIsJellystatImporting(false);
      setJellystatActiveJobId(null);
      setJellystatProgress({
        status: 'error',
        totalRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        skippedRecords: 0,
        errorRecords: 0,
        filteredRecords: 0,
        enrichedRecords: 0,
        message: err instanceof Error ? err.message : 'Import failed',
      });
    }
  };

  // Convert progress types for the reusable component
  const tautulliProgressData: ImportProgressData | null = tautulliProgress
    ? {
        status: tautulliProgress.status === 'fetching' ? 'fetching' : tautulliProgress.status,
        message: tautulliProgress.message,
        totalRecords: tautulliProgress.totalRecords,
        processedRecords: tautulliProgress.processedRecords,
        importedRecords: tautulliProgress.importedRecords,
        skippedRecords: tautulliProgress.skippedRecords,
        errorRecords: tautulliProgress.errorRecords,
        currentPage: tautulliProgress.currentPage,
        totalPages: tautulliProgress.totalPages,
      }
    : null;

  const jellystatProgressData: ImportProgressData | null = jellystatProgress
    ? {
        status:
          jellystatProgress.status === 'parsing' || jellystatProgress.status === 'enriching'
            ? 'processing'
            : jellystatProgress.status,
        message: jellystatProgress.message,
        totalRecords: jellystatProgress.totalRecords,
        processedRecords: jellystatProgress.processedRecords,
        importedRecords: jellystatProgress.importedRecords,
        skippedRecords: jellystatProgress.skippedRecords,
        filteredRecords: jellystatProgress.filteredRecords,
        errorRecords: jellystatProgress.errorRecords,
        enrichedRecords: jellystatProgress.enrichedRecords,
      }
    : null;

  if (settingsLoading || serversLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const hasPlexServers = plexServers.length > 0;
  const hasJellyfinEmbyServers = jellyfinEmbyServers.length > 0;
  const hasBothServerTypes = hasPlexServers && hasJellyfinEmbyServers;

  // Determine default tab based on available server types
  const defaultTab = hasPlexServers ? 'plex' : 'jellyfin';

  // No servers state
  if (!hasPlexServers && !hasJellyfinEmbyServers) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Import History
          </CardTitle>
          <CardDescription>Import historical watch data from external sources</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
            <ServerIcon className="text-muted-foreground h-8 w-8" />
            <div className="text-center">
              <p className="font-medium">No Servers Connected</p>
              <p className="text-muted-foreground mt-1 text-sm">
                Add a media server first to import historical watch data.
              </p>
            </div>
            <Button variant="outline" asChild>
              <a href="/settings/servers">Add Server</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          Import History
        </CardTitle>
        <CardDescription>
          Import historical watch data from external sources like Tautulli or Jellystat
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasBothServerTypes ? (
          <Tabs defaultValue={defaultTab} className="w-full">
            <TabsList className="mb-6 grid w-full grid-cols-2">
              <TabsTrigger value="plex" className="flex items-center gap-2">
                <MediaServerIcon type="plex" className="h-4 w-4" />
                Plex (Tautulli)
              </TabsTrigger>
              <TabsTrigger value="jellyfin" className="flex items-center gap-2">
                <MediaServerIcon type="jellyfin" className="h-4 w-4" />
                Jellyfin/Emby (Jellystat)
              </TabsTrigger>
            </TabsList>

            <TabsContent value="plex" className="mt-0 space-y-6">
              <TautulliImportSection
                tautulliUrl={tautulliUrl}
                setTautulliUrl={setTautulliUrl}
                tautulliApiKey={tautulliApiKey}
                setTautulliApiKey={setTautulliApiKey}
                connectionStatus={connectionStatus}
                connectionMessage={connectionMessage}
                handleTestConnection={handleTestConnection}
                plexServers={plexServers}
                selectedPlexServerId={selectedPlexServerId}
                setSelectedPlexServerId={setSelectedPlexServerId}
                isTautulliImporting={isTautulliImporting}
                overwriteFriendlyNames={overwriteFriendlyNames}
                setOverwriteFriendlyNames={setOverwriteFriendlyNames}
                includeStreamDetails={includeStreamDetails}
                setIncludeStreamDetails={setIncludeStreamDetails}
                handleStartTautulliImport={handleStartTautulliImport}
                tautulliProgressData={tautulliProgressData}
              />
            </TabsContent>

            <TabsContent value="jellyfin" className="mt-0 space-y-6">
              <JellystatImportSection
                jellyfinEmbyServers={jellyfinEmbyServers}
                selectedJellyfinServerId={selectedJellyfinServerId}
                setSelectedJellyfinServerId={setSelectedJellyfinServerId}
                selectedFile={selectedFile}
                handleFileSelect={handleFileSelect}
                enrichMedia={enrichMedia}
                setEnrichMedia={setEnrichMedia}
                updateStreamDetails={updateStreamDetails}
                setUpdateStreamDetails={setUpdateStreamDetails}
                isJellystatImporting={isJellystatImporting}
                handleStartJellystatImport={handleStartJellystatImport}
                jellystatProgressData={jellystatProgressData}
              />
            </TabsContent>
          </Tabs>
        ) : hasPlexServers ? (
          <TautulliImportSection
            tautulliUrl={tautulliUrl}
            setTautulliUrl={setTautulliUrl}
            tautulliApiKey={tautulliApiKey}
            setTautulliApiKey={setTautulliApiKey}
            connectionStatus={connectionStatus}
            connectionMessage={connectionMessage}
            handleTestConnection={handleTestConnection}
            plexServers={plexServers}
            selectedPlexServerId={selectedPlexServerId}
            setSelectedPlexServerId={setSelectedPlexServerId}
            isTautulliImporting={isTautulliImporting}
            overwriteFriendlyNames={overwriteFriendlyNames}
            setOverwriteFriendlyNames={setOverwriteFriendlyNames}
            includeStreamDetails={includeStreamDetails}
            setIncludeStreamDetails={setIncludeStreamDetails}
            handleStartTautulliImport={handleStartTautulliImport}
            tautulliProgressData={tautulliProgressData}
          />
        ) : (
          <JellystatImportSection
            jellyfinEmbyServers={jellyfinEmbyServers}
            selectedJellyfinServerId={selectedJellyfinServerId}
            setSelectedJellyfinServerId={setSelectedJellyfinServerId}
            selectedFile={selectedFile}
            handleFileSelect={handleFileSelect}
            enrichMedia={enrichMedia}
            setEnrichMedia={setEnrichMedia}
            updateStreamDetails={updateStreamDetails}
            setUpdateStreamDetails={setUpdateStreamDetails}
            isJellystatImporting={isJellystatImporting}
            handleStartJellystatImport={handleStartJellystatImport}
            jellystatProgressData={jellystatProgressData}
          />
        )}
      </CardContent>
    </Card>
  );
}
