/**
 * Ntfy Notification Agent
 *
 * Sends notifications to ntfy.sh or self-hosted ntfy servers.
 */

import { BaseAgent } from './base.js';
import type {
  NotificationPayload,
  NotificationSettings,
  NotificationEventType,
  SendResult,
  TestResult,
  ViolationContext,
  SessionContext,
  ServerContext,
  NewDeviceContext,
  TrustScoreChangedContext,
} from '../types.js';
import { formatViolationMessage } from '../formatters/violation.js';

interface NtfyPayload {
  topic: string;
  title: string;
  message: string;
  priority: number;
  tags: string[];
}

export class NtfyAgent extends BaseAgent {
  readonly name = 'ntfy';
  readonly displayName = 'Ntfy';

  shouldSend(_event: NotificationEventType, settings: NotificationSettings): boolean {
    return settings.webhookFormat === 'ntfy' && !!settings.customWebhookUrl;
  }

  async send(payload: NotificationPayload, settings: NotificationSettings): Promise<SendResult> {
    if (!settings.customWebhookUrl) {
      return this.handleError(new Error('Custom webhook URL not configured'), 'send');
    }

    try {
      const ntfyPayload = this.buildNtfyPayload(payload, settings.ntfyTopic);
      await this.sendWebhook(settings.customWebhookUrl, ntfyPayload, settings.ntfyAuthToken);
      return this.successResult();
    } catch (error) {
      return this.handleError(error, 'send');
    }
  }

  async sendTest(settings: NotificationSettings): Promise<TestResult> {
    if (!settings.customWebhookUrl) {
      return this.failureTestResult('Custom webhook URL not configured');
    }

    try {
      const payload: NtfyPayload = {
        topic: settings.ntfyTopic || 'tracearr',
        title: 'Test Notification',
        message: 'This is a test notification from Tracearr',
        priority: 3,
        tags: ['tracearr'],
      };
      await this.sendWebhook(settings.customWebhookUrl, payload, settings.ntfyAuthToken);
      return this.successTestResult();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.failureTestResult(message);
    }
  }

  private buildNtfyPayload(payload: NotificationPayload, topic: string | null): NtfyPayload {
    const ntfyTopic = topic || 'tracearr';

    switch (payload.context.type) {
      case 'violation_detected':
        return this.buildViolationPayload(ntfyTopic, payload.context);
      case 'stream_started':
        return this.buildSessionStartedPayload(ntfyTopic, payload.context);
      case 'stream_stopped':
        return this.buildSessionStoppedPayload(ntfyTopic, payload.context);
      case 'server_down':
        return this.buildServerDownPayload(ntfyTopic, payload.context);
      case 'server_up':
        return this.buildServerUpPayload(ntfyTopic, payload.context);
      case 'new_device':
        return this.buildNewDevicePayload(ntfyTopic, payload.context);
      case 'trust_score_changed':
        return this.buildTrustScoreChangedPayload(ntfyTopic, payload.context);
    }
  }

  private buildViolationPayload(topic: string, ctx: ViolationContext): NtfyPayload {
    return {
      topic,
      title: 'Violation Detected',
      message: formatViolationMessage(ctx.violation),
      priority: this.severityToNtfyPriority(ctx.violation.severity),
      tags: ['tracearr'],
    };
  }

  private buildSessionStartedPayload(topic: string, ctx: SessionContext): NtfyPayload {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);
    const userName = this.getUserDisplayName(session);
    const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;

    return {
      topic,
      title: 'Stream Started',
      message: `${userName} started watching ${mediaDisplay}`,
      priority: 3,
      tags: ['tracearr'],
    };
  }

  private buildSessionStoppedPayload(topic: string, ctx: SessionContext): NtfyPayload {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);
    const userName = this.getUserDisplayName(session);
    const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;
    const durationStr = session.durationMs ? ` (${this.formatDuration(session.durationMs)})` : '';

    return {
      topic,
      title: 'Stream Ended',
      message: `${userName} finished watching ${mediaDisplay}${durationStr}`,
      priority: 3,
      tags: ['tracearr'],
    };
  }

  private buildServerDownPayload(topic: string, ctx: ServerContext): NtfyPayload {
    return {
      topic,
      title: 'Server Offline',
      message: `${ctx.serverName} is not responding`,
      priority: 5,
      tags: ['tracearr'],
    };
  }

  private buildServerUpPayload(topic: string, ctx: ServerContext): NtfyPayload {
    return {
      topic,
      title: 'Server Online',
      message: `${ctx.serverName} is back online`,
      priority: 4,
      tags: ['tracearr'],
    };
  }

  private buildNewDevicePayload(topic: string, ctx: NewDeviceContext): NtfyPayload {
    const locationStr = ctx.location ? ` from ${ctx.location}` : '';
    return {
      topic,
      title: 'New Device Detected',
      message: `${ctx.userName} connected from a new device: ${ctx.deviceName}${locationStr}`,
      priority: 4,
      tags: ['tracearr'],
    };
  }

  private buildTrustScoreChangedPayload(topic: string, ctx: TrustScoreChangedContext): NtfyPayload {
    const direction = ctx.newScore < ctx.previousScore ? 'decreased' : 'increased';
    const reasonStr = ctx.reason ? `: ${ctx.reason}` : '';
    return {
      topic,
      title: 'Trust Score Changed',
      message: `${ctx.userName}'s trust score ${direction} from ${ctx.previousScore} to ${ctx.newScore}${reasonStr}`,
      priority: ctx.newScore < ctx.previousScore ? 4 : 3,
      tags: ['tracearr'],
    };
  }

  private severityToNtfyPriority(severity: string): number {
    const map: Record<string, number> = { high: 5, warning: 4, low: 3 };
    return map[severity] ?? 3;
  }

  private async sendWebhook(
    webhookUrl: string,
    payload: NtfyPayload,
    authToken: string | null
  ): Promise<void> {
    const { url, authHeaders } = this.buildFetchOptions(webhookUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Ntfy webhook failed: ${response.status} ${text}`.trim());
    }
  }
}
