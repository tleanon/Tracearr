/**
 * Settings page with sub-routes for different settings sections.
 * Components are organized in components/settings/ for maintainability.
 */
import { NavLink, Routes, Route } from 'react-router';
import { cn } from '@/lib/utils';

// Settings section components
import { GeneralSettings } from '@/components/settings/GeneralSettings';
import { ServerSettings } from '@/components/settings/ServerSettings';
import { AccessSettings } from '@/components/settings/AccessSettings';
import { MobileSettings } from '@/components/settings/MobileSettings';
import { TailscaleSettings } from '@/components/settings/TailscaleSettings';
import { ImportSettings } from '@/components/settings/ImportSettings';
import { JobsSettings } from '@/components/settings/JobsSettings';
import { NotificationAgentsManager } from '@/components/settings/notification-agents';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Bell } from 'lucide-react';

function SettingsNav() {
  const links = [
    { href: '/settings', label: 'General', end: true },
    { href: '/settings/servers', label: 'Servers' },
    { href: '/settings/notifications', label: 'Notifications' },
    { href: '/settings/access', label: 'Access Control' },
    { href: '/settings/mobile', label: 'Mobile' },
    { href: '/settings/tailscale', label: 'Tailscale' },
    { href: '/settings/import', label: 'Import' },
    { href: '/settings/jobs', label: 'Jobs' },
  ];

  return (
    <nav className="flex space-x-4 border-b pb-4">
      {links.map((link) => (
        <NavLink
          key={link.href}
          to={link.href}
          end={link.end}
          className={({ isActive }) =>
            cn(
              'text-sm font-medium transition-colors',
              isActive ? 'text-primary' : 'text-muted-foreground hover:text-primary'
            )
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}

function NotificationSettings() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Notification Agents
        </CardTitle>
        <CardDescription>
          Configure notification channels and select which events each agent should receive.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <NotificationAgentsManager />
      </CardContent>
    </Card>
  );
}

export function Settings() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Settings</h1>
      <SettingsNav />
      <Routes>
        <Route index element={<GeneralSettings />} />
        <Route path="servers" element={<ServerSettings />} />
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="access" element={<AccessSettings />} />
        <Route path="mobile" element={<MobileSettings />} />
        <Route path="tailscale" element={<TailscaleSettings />} />
        <Route path="import" element={<ImportSettings />} />
        <Route path="jobs" element={<JobsSettings />} />
      </Routes>
    </div>
  );
}
