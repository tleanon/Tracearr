/**
 * Table component for displaying history sessions.
 * Features columns for all session data, supports virtual scroll and column visibility.
 */

import { forwardRef, useRef, useEffect, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link } from 'react-router';
import {
  Film,
  Tv,
  Music,
  Radio,
  Image,
  CircleHelp,
  Play,
  Pause,
  MonitorPlay,
  Zap,
  Cpu,
  Globe,
  Clock,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Clapperboard,
} from 'lucide-react';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatLocationCompact, getCountryName, getMediaDisplay } from '@/lib/utils';
import { formatDuration } from '@/lib/formatters';
import { getAvatarUrl } from '@/components/users/utils';
import type { SessionWithDetails, SessionState, MediaType, EngagementTier } from '@tracearr/shared';
import type { ColumnVisibility } from './HistoryFilters';
import { format } from 'date-fns';
import { getTimeFormatString } from '@/lib/timeFormat';

// Engagement tier config
const ENGAGEMENT_TIER_CONFIG: Record<
  EngagementTier,
  { label: string; shortLabel: string; color: string; bgClass: string }
> = {
  abandoned: {
    label: 'Abandoned (<20%)',
    shortLabel: 'Abandoned',
    color: 'text-red-600',
    bgClass: 'bg-red-100 dark:bg-red-900/30',
  },
  sampled: {
    label: 'Sampled (20-49%)',
    shortLabel: 'Sampled',
    color: 'text-orange-600',
    bgClass: 'bg-orange-100 dark:bg-orange-900/30',
  },
  engaged: {
    label: 'Engaged (50-84%)',
    shortLabel: 'Engaged',
    color: 'text-yellow-600',
    bgClass: 'bg-yellow-100 dark:bg-yellow-900/30',
  },
  watched: {
    label: 'Watched (85%+)',
    shortLabel: 'Watched',
    color: 'text-green-600',
    bgClass: 'bg-green-100 dark:bg-green-900/30',
  },
  rewatched: {
    label: 'Rewatched (200%+)',
    shortLabel: 'Rewatched',
    color: 'text-blue-600',
    bgClass: 'bg-blue-100 dark:bg-blue-900/30',
  },
  unknown: {
    label: 'Unknown',
    shortLabel: '?',
    color: 'text-muted-foreground',
    bgClass: 'bg-muted',
  },
};

function getEngagementTier(progress: number, hasDuration: boolean): EngagementTier {
  if (!hasDuration) return 'unknown';
  if (progress >= 200) return 'rewatched';
  if (progress >= 85) return 'watched';
  if (progress >= 50) return 'engaged';
  if (progress >= 20) return 'sampled';
  return 'abandoned';
}

function EngagementTierBadge({
  progress,
  state,
  hasDuration,
}: {
  progress: number;
  state: SessionState;
  hasDuration: boolean;
}) {
  const tier = getEngagementTier(progress, hasDuration);
  if (tier === 'unknown' || state !== 'stopped') return null;

  const config = ENGAGEMENT_TIER_CONFIG[tier];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'rounded px-1 py-0.5 text-[10px] font-medium',
            config.color,
            config.bgClass
          )}
        >
          {config.shortLabel}
        </span>
      </TooltipTrigger>
      <TooltipContent>{config.label}</TooltipContent>
    </Tooltip>
  );
}

// Sortable column keys that the API supports
export type SortableColumn = 'startedAt' | 'durationMs' | 'mediaTitle';
export type SortDirection = 'asc' | 'desc';

interface Props {
  sessions: SessionWithDetails[];
  isLoading?: boolean;
  isFetchingNextPage?: boolean;
  hasNextPage?: boolean;
  onLoadMore?: () => void;
  onSessionClick?: (session: SessionWithDetails) => void;
  columnVisibility: ColumnVisibility;
  sortBy?: SortableColumn;
  sortDir?: SortDirection;
  onSortChange?: (column: SortableColumn) => void;
  // Selection props
  selectable?: boolean;
  selectedIds?: Set<string>;
  selectAllMode?: boolean;
  onRowSelect?: (session: SessionWithDetails) => void;
  onSelectAllVisible?: () => void;
  isAllVisibleSelected?: boolean;
  isAllVisibleIndeterminate?: boolean;
}

// State icon component
function StateIcon({ state }: { state: SessionState }) {
  if (state === 'stopped') return null;

  const config: Record<'playing' | 'paused', { icon: typeof Play; color: string; label: string }> =
    {
      playing: { icon: Play, color: 'text-green-500', label: 'Playing' },
      paused: { icon: Pause, color: 'text-yellow-500', label: 'Paused' },
    };
  const { icon: Icon, color, label } = config[state];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Icon className={cn('h-4 w-4', color)} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Media type icon component
function MediaTypeIcon({ type }: { type: MediaType }) {
  const config: Record<MediaType, { icon: typeof Film; label: string }> = {
    movie: { icon: Film, label: 'Movie' },
    episode: { icon: Tv, label: 'TV Episode' },
    track: { icon: Music, label: 'Music' },
    live: { icon: Radio, label: 'Live TV' },
    photo: { icon: Image, label: 'Photo' },
    trailer: { icon: Clapperboard, label: 'Trailer' },
    unknown: { icon: CircleHelp, label: 'Unknown' },
  };
  const { icon: Icon, label } = config[type];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Icon className="text-muted-foreground h-4 w-4" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Calculate progress percentage (playback position)
// Uses progressMs (where in the video) not durationMs (how long watched)
function getProgress(session: SessionWithDetails): number {
  if (!session.totalDurationMs || session.totalDurationMs === 0) return 0;
  const progress = session.progressMs ?? 0;
  return Math.min(100, Math.round((progress / session.totalDurationMs) * 100));
}

interface HistoryTableRowProps {
  session: SessionWithDetails;
  onClick?: () => void;
  columnVisibility: ColumnVisibility;
  selectable?: boolean;
  isSelected?: boolean;
  onSelect?: () => void;
  style?: React.CSSProperties;
  'data-index'?: number;
}

// Session row component with column visibility support
export const HistoryTableRow = memo(
  forwardRef<HTMLTableRowElement, HistoryTableRowProps>(
    (
      {
        session,
        onClick,
        columnVisibility,
        selectable,
        isSelected,
        onSelect,
        style,
        'data-index': dataIndex,
      },
      ref
    ) => {
      const { title: primary, subtitle: secondary } = getMediaDisplay(session);
      const progress = getProgress(session);

      return (
        <TableRow
          ref={ref}
          data-index={dataIndex}
          style={style}
          className={cn(
            'cursor-pointer transition-colors',
            onClick && 'hover:bg-muted/50',
            isSelected && 'bg-muted/50'
          )}
          onClick={onClick}
        >
          {/* Selection checkbox */}
          {selectable && (
            <TableCell className="w-10">
              <Checkbox
                checked={isSelected}
                onCheckedChange={onSelect}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select session`}
              />
            </TableCell>
          )}

          {/* Date/Time with State */}
          {columnVisibility.date && (
            <TableCell className="w-[140px]">
              <div className="flex items-center gap-2">
                <StateIcon state={session.state} />
                <div>
                  <div className="text-sm font-medium">
                    {format(new Date(session.startedAt), 'MMM d, yyyy')}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {format(new Date(session.startedAt), getTimeFormatString())}
                  </div>
                </div>
              </div>
            </TableCell>
          )}

          {/* User */}
          {columnVisibility.user && (
            <TableCell className="w-[150px]">
              <Link
                to={`/users/${session.serverUserId}`}
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-2 hover:underline"
              >
                <Avatar className="h-6 w-6">
                  <AvatarImage
                    src={getAvatarUrl(session.serverId, session.user.thumbUrl, 24) ?? undefined}
                  />
                  <AvatarFallback className="text-xs">
                    {(session.user.identityName ?? session.user.username)?.[0]?.toUpperCase() ??
                      '?'}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {session.user.identityName ?? session.user.username}
                  </span>
                  {session.user.identityName &&
                    session.user.identityName !== session.user.username && (
                      <span className="text-muted-foreground block truncate text-xs">
                        @{session.user.username}
                      </span>
                    )}
                </div>
              </Link>
            </TableCell>
          )}

          {/* Content */}
          {columnVisibility.content && (
            <TableCell className="max-w-[300px] min-w-[200px]">
              <div className="flex items-center gap-2">
                <MediaTypeIcon type={session.mediaType} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{primary}</span>
                    <EngagementTierBadge
                      progress={progress}
                      state={session.state}
                      hasDuration={!!session.totalDurationMs}
                    />
                  </div>
                  {secondary && (
                    <div className="text-muted-foreground truncate text-xs">{secondary}</div>
                  )}
                </div>
              </div>
            </TableCell>
          )}

          {/* Platform/Device */}
          {columnVisibility.platform && (
            <TableCell className="w-[120px]">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <div className="truncate text-sm">{session.platform ?? '—'}</div>
                    {session.product && (
                      <div className="text-muted-foreground truncate text-xs">
                        {session.product}
                      </div>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="space-y-1 text-xs">
                    {session.platform && <div>Platform: {session.platform}</div>}
                    {session.product && <div>Product: {session.product}</div>}
                    {session.device && <div>Device: {session.device}</div>}
                    {session.playerName && <div>Player: {session.playerName}</div>}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TableCell>
          )}

          {/* Location */}
          {columnVisibility.location && (
            <TableCell className="w-[130px]">
              {session.geoCity || session.geoCountry ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5">
                      <Globe className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                      <span className="truncate text-sm">
                        {formatLocationCompact(
                          session.geoCity,
                          session.geoRegion,
                          session.geoCountry
                        )}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="space-y-1 text-xs">
                      {session.geoCity && <div>City: {session.geoCity}</div>}
                      {session.geoRegion && <div>Region: {session.geoRegion}</div>}
                      {session.geoCountry && (
                        <div>Country: {getCountryName(session.geoCountry)}</div>
                      )}
                      {session.ipAddress && <div>IP: {session.ipAddress}</div>}
                    </div>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
          )}

          {/* IP Address */}
          {columnVisibility.ip && (
            <TableCell className="w-[120px]">
              <span className="text-muted-foreground font-mono text-xs">
                {session.ipAddress || '—'}
              </span>
            </TableCell>
          )}

          {/* Quality */}
          {columnVisibility.quality && (
            <TableCell className="w-[110px]">
              {(() => {
                const isHwTranscode =
                  session.isTranscode &&
                  !!(session.transcodeInfo?.hwEncoding || session.transcodeInfo?.hwDecoding);

                if (session.isTranscode) {
                  return (
                    <Badge variant="warning" className="gap-1 text-xs">
                      {isHwTranscode ? <Cpu className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
                      Transcode
                    </Badge>
                  );
                }

                return (
                  <Badge variant="success" className="gap-1 text-xs">
                    <MonitorPlay className="h-3 w-3" />
                    {session.videoDecision === 'copy' || session.audioDecision === 'copy'
                      ? 'Direct Stream'
                      : 'Direct Play'}
                  </Badge>
                );
              })()}
            </TableCell>
          )}

          {/* Duration */}
          {columnVisibility.duration && (
            <TableCell className="w-[100px]">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5">
                    <Clock className="text-muted-foreground h-3.5 w-3.5" />
                    <span className="text-sm">
                      {formatDuration(session.durationMs, { style: 'compact' })}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="space-y-1 text-xs">
                    <div>
                      Watch time: {formatDuration(session.durationMs, { style: 'compact' })}
                    </div>
                    {session.pausedDurationMs > 0 && (
                      <div>
                        Paused: {formatDuration(session.pausedDurationMs, { style: 'compact' })}
                      </div>
                    )}
                    {session.totalDurationMs && (
                      <div>
                        Media length:{' '}
                        {formatDuration(session.totalDurationMs, { style: 'compact' })}
                      </div>
                    )}
                    {session.segmentCount && session.segmentCount > 1 && (
                      <div>Segments: {session.segmentCount}</div>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TableCell>
          )}

          {/* Progress */}
          {columnVisibility.progress && (
            <TableCell className="w-[100px]">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2">
                    <Progress value={progress} className="h-1.5 w-12" />
                    <span className="text-muted-foreground text-xs">{progress}%</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {progress}% complete
                  {session.watched && ' (watched)'}
                </TooltipContent>
              </Tooltip>
            </TableCell>
          )}
        </TableRow>
      );
    }
  )
);
HistoryTableRow.displayName = 'HistoryTableRow';

// Loading skeleton row with column visibility support
function SkeletonRow({
  columnVisibility,
  selectable = false,
}: {
  columnVisibility: ColumnVisibility;
  selectable?: boolean;
}) {
  return (
    <TableRow style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}>
      {selectable && (
        <TableCell className="w-10">
          <Skeleton className="h-4 w-4" />
        </TableCell>
      )}
      {columnVisibility.date && (
        <TableCell>
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <div className="space-y-1">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-14" />
            </div>
          </div>
        </TableCell>
      )}
      {columnVisibility.user && (
        <TableCell>
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-4 w-20" />
          </div>
        </TableCell>
      )}
      {columnVisibility.content && (
        <TableCell>
          <div className="space-y-1">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
        </TableCell>
      )}
      {columnVisibility.platform && (
        <TableCell>
          <div className="space-y-1">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        </TableCell>
      )}
      {columnVisibility.location && (
        <TableCell>
          <Skeleton className="h-4 w-20" />
        </TableCell>
      )}
      {columnVisibility.ip && (
        <TableCell>
          <Skeleton className="h-4 w-24" />
        </TableCell>
      )}
      {columnVisibility.quality && (
        <TableCell>
          <Skeleton className="h-5 w-20 rounded-full" />
        </TableCell>
      )}
      {columnVisibility.duration && (
        <TableCell>
          <Skeleton className="h-4 w-14" />
        </TableCell>
      )}
      {columnVisibility.progress && (
        <TableCell>
          <div className="flex items-center gap-2">
            <Skeleton className="h-1.5 w-12" />
            <Skeleton className="h-3 w-8" />
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

// Count visible columns for empty state colspan
function getVisibleColumnCount(columnVisibility: ColumnVisibility): number {
  return Object.values(columnVisibility).filter(Boolean).length;
}

// Sortable header component
function SortableHeader({
  column,
  label,
  currentSortBy,
  currentSortDir,
  onSortChange,
}: {
  column: SortableColumn;
  label: string;
  currentSortBy?: SortableColumn;
  currentSortDir?: SortDirection;
  onSortChange?: (column: SortableColumn) => void;
}) {
  const isActive = currentSortBy === column;
  const Icon = isActive ? (currentSortDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <button
      type="button"
      className="hover:text-foreground flex items-center gap-1 transition-colors"
      onClick={() => onSortChange?.(column)}
    >
      {label}
      <Icon className={cn('h-3.5 w-3.5', isActive ? 'opacity-100' : 'opacity-40')} />
    </button>
  );
}

export function HistoryTable({
  sessions,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  onLoadMore,
  onSessionClick,
  columnVisibility,
  sortBy,
  sortDir,
  onSortChange,
  selectable = false,
  selectedIds,
  selectAllMode = false,
  onRowSelect,
  onSelectAllVisible,
  isAllVisibleSelected = false,
  isAllVisibleIndeterminate: _isAllVisibleIndeterminate = false,
}: Props) {
  const visibleColumnCount = getVisibleColumnCount(columnVisibility) + (selectable ? 1 : 0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 53,
    overscan: 10,
  });

  // Trigger load more when user scrolls near the end of the list
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl || !hasNextPage || isFetchingNextPage || !onLoadMore) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      // Load more when within 200px of the bottom
      if (scrollHeight - scrollTop - clientHeight < 200) {
        onLoadMore();
      }
    };

    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  // Initial loading state: render full-width table with skeleton rows (no virtualizer needed)
  if (isLoading) {
    return (
      <div
        className="scrollbar-thin relative overflow-auto"
        style={{ maxHeight: 'clamp(400px, 70vh, calc(100vh - 200px))' }}
      >
        <table className="w-full caption-bottom text-sm">
          <thead
            className="bg-card sticky top-0 z-10 [&_tr]:border-b"
            style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}
          >
            <tr>
              {selectable && <TableHead className="w-10" />}
              {columnVisibility.date && <TableHead className="w-[140px]">Date</TableHead>}
              {columnVisibility.user && <TableHead className="w-[150px]">User</TableHead>}
              {columnVisibility.content && <TableHead className="min-w-[200px]">Content</TableHead>}
              {columnVisibility.platform && <TableHead className="w-[120px]">Platform</TableHead>}
              {columnVisibility.location && <TableHead className="w-[130px]">Location</TableHead>}
              {columnVisibility.ip && <TableHead className="w-[120px]">IP Address</TableHead>}
              {columnVisibility.quality && <TableHead className="w-[110px]">Quality</TableHead>}
              {columnVisibility.duration && <TableHead className="w-[100px]">Duration</TableHead>}
              {columnVisibility.progress && <TableHead className="w-[100px]">Progress</TableHead>}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }).map((_, i) => (
              <SkeletonRow key={i} columnVisibility={columnVisibility} selectable={selectable} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Empty state
  if (sessions.length === 0) {
    return (
      <div
        className="scrollbar-thin relative overflow-auto"
        style={{ maxHeight: 'clamp(400px, 70vh, calc(100vh - 200px))' }}
      >
        <table className="w-full caption-bottom text-sm">
          <thead
            className="bg-card sticky top-0 z-10 [&_tr]:border-b"
            style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}
          >
            <tr>
              {selectable && <TableHead className="w-10" />}
              {columnVisibility.date && <TableHead className="w-[140px]">Date</TableHead>}
              {columnVisibility.user && <TableHead className="w-[150px]">User</TableHead>}
              {columnVisibility.content && <TableHead className="min-w-[200px]">Content</TableHead>}
              {columnVisibility.platform && <TableHead className="w-[120px]">Platform</TableHead>}
              {columnVisibility.location && <TableHead className="w-[130px]">Location</TableHead>}
              {columnVisibility.ip && <TableHead className="w-[120px]">IP Address</TableHead>}
              {columnVisibility.quality && <TableHead className="w-[110px]">Quality</TableHead>}
              {columnVisibility.duration && <TableHead className="w-[100px]">Duration</TableHead>}
              {columnVisibility.progress && <TableHead className="w-[100px]">Progress</TableHead>}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={visibleColumnCount} className="h-32 text-center">
                <div className="text-muted-foreground flex flex-col items-center gap-2">
                  <Clock className="h-8 w-8" />
                  <p>No sessions found</p>
                  <p className="text-sm">Try adjusting your filters</p>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      className="scrollbar-thin relative overflow-auto"
      style={{ maxHeight: 'clamp(400px, 70vh, calc(100vh - 200px))' }}
    >
      <table className="w-full caption-bottom text-sm">
        <thead
          className="bg-card sticky top-0 z-10 [&_tr]:border-b"
          style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}
        >
          <tr>
            {selectable && (
              <TableHead className="w-10">
                <Checkbox
                  checked={selectAllMode || isAllVisibleSelected}
                  onCheckedChange={onSelectAllVisible}
                  aria-label="Select all visible"
                />
              </TableHead>
            )}
            {columnVisibility.date && (
              <TableHead className="w-[140px]">
                <SortableHeader
                  column="startedAt"
                  label="Date"
                  currentSortBy={sortBy}
                  currentSortDir={sortDir}
                  onSortChange={onSortChange}
                />
              </TableHead>
            )}
            {columnVisibility.user && <TableHead className="w-[150px]">User</TableHead>}
            {columnVisibility.content && (
              <TableHead className="min-w-[200px]">
                <SortableHeader
                  column="mediaTitle"
                  label="Content"
                  currentSortBy={sortBy}
                  currentSortDir={sortDir}
                  onSortChange={onSortChange}
                />
              </TableHead>
            )}
            {columnVisibility.platform && <TableHead className="w-[120px]">Platform</TableHead>}
            {columnVisibility.location && <TableHead className="w-[130px]">Location</TableHead>}
            {columnVisibility.ip && <TableHead className="w-[120px]">IP Address</TableHead>}
            {columnVisibility.quality && <TableHead className="w-[110px]">Quality</TableHead>}
            {columnVisibility.duration && (
              <TableHead className="w-[100px]">
                <SortableHeader
                  column="durationMs"
                  label="Duration"
                  currentSortBy={sortBy}
                  currentSortDir={sortDir}
                  onSortChange={onSortChange}
                />
              </TableHead>
            )}
            {columnVisibility.progress && <TableHead className="w-[100px]">Progress</TableHead>}
          </tr>
        </thead>
        <tbody
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            position: 'relative',
            display: 'block',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const session = sessions[virtualRow.index];
            if (!session) return null;
            return (
              <HistoryTableRow
                key={session.id}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  display: 'table',
                  tableLayout: 'fixed',
                }}
                session={session}
                onClick={onSessionClick ? () => onSessionClick(session) : undefined}
                columnVisibility={columnVisibility}
                selectable={selectable}
                isSelected={selectAllMode || (selectedIds?.has(session.id) ?? false)}
                onSelect={onRowSelect ? () => onRowSelect(session) : undefined}
              />
            );
          })}
        </tbody>
      </table>

      {/* Skeleton rows shown while fetching next page, rendered below the virtual table */}
      {isFetchingNextPage && (
        <table className="w-full caption-bottom text-sm" style={{ tableLayout: 'fixed' }}>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow
                key={`loading-${i}`}
                columnVisibility={columnVisibility}
                selectable={selectable}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
