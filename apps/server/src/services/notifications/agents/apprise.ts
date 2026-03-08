/**
 * Apprise Notification Agent
 *
 * Sends notifications via Apprise API servers.
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

interface ApprisePayload {
  title: string;
  body: string;
  type: 'info' | 'success' | 'warning' | 'failure';
}

export class AppriseAgent extends BaseAgent {
  readonly name = 'apprise';
  readonly displayName = 'Apprise';

  shouldSend(_event: NotificationEventType, settings: NotificationSettings): boolean {
    return settings.webhookFormat === 'apprise' && !!settings.customWebhookUrl;
  }

  async send(payload: NotificationPayload, settings: NotificationSettings): Promise<SendResult> {
    if (!settings.customWebhookUrl) {
      return this.handleError(new Error('Custom webhook URL not configured'), 'send');
    }

    try {
      const apprisePayload = this.buildApprisePayload(payload);
      await this.sendWebhook(settings.customWebhookUrl, apprisePayload);
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
      const payload: ApprisePayload = {
        title: 'Test Notification',
        body: 'This is a test notification from Tracearr',
        type: 'info',
      };
      await this.sendWebhook(settings.customWebhookUrl, payload);
      return this.successTestResult();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.failureTestResult(message);
    }
  }

  private buildApprisePayload(payload: NotificationPayload): ApprisePayload {
    switch (payload.context.type) {
      case 'violation_detected':
        return this.buildViolationPayload(payload.context);
      case 'stream_started':
        return this.buildSessionStartedPayload(payload.context);
      case 'stream_stopped':
        return this.buildSessionStoppedPayload(payload.context);
      case 'server_down':
        return this.buildServerDownPayload(payload.context);
      case 'server_up':
        return this.buildServerUpPayload(payload.context);
      case 'new_device':
        return this.buildNewDevicePayload(payload.context);
      case 'trust_score_changed':
        return this.buildTrustScoreChangedPayload(payload.context);
    }
  }

  private buildViolationPayload(ctx: ViolationContext): ApprisePayload {
    return {
      title: 'Violation Detected',
      body: formatViolationMessage(ctx.violation),
      type: this.severityToAppriseType(ctx.violation.severity),
    };
  }

  private buildSessionStartedPayload(ctx: SessionContext): ApprisePayload {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);
    const userName = this.getUserDisplayName(session);
    const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;

    return {
      title: 'Stream Started',
      body: `${userName} started watching ${mediaDisplay}`,
      type: 'info',
    };
  }

  private buildSessionStoppedPayload(ctx: SessionContext): ApprisePayload {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);
    const userName = this.getUserDisplayName(session);
    const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;
    const durationStr = session.durationMs ? ` (${this.formatDuration(session.durationMs)})` : '';

    return {
      title: 'Stream Ended',
      body: `${userName} finished watching ${mediaDisplay}${durationStr}`,
      type: 'info',
    };
  }

  private buildServerDownPayload(ctx: ServerContext): ApprisePayload {
    return {
      title: 'Server Offline',
      body: `${ctx.serverName} is not responding`,
      type: 'failure',
    };
  }

  private buildServerUpPayload(ctx: ServerContext): ApprisePayload {
    return {
      title: 'Server Online',
      body: `${ctx.serverName} is back online`,
      type: 'success',
    };
  }

  private buildNewDevicePayload(ctx: NewDeviceContext): ApprisePayload {
    const locationStr = ctx.location ? ` from ${ctx.location}` : '';
    return {
      title: 'New Device Detected',
      body: `${ctx.userName} connected from a new device: ${ctx.deviceName}${locationStr}`,
      type: 'warning',
    };
  }

  private buildTrustScoreChangedPayload(ctx: TrustScoreChangedContext): ApprisePayload {
    const direction = ctx.newScore < ctx.previousScore ? 'decreased' : 'increased';
    const reasonStr = ctx.reason ? `: ${ctx.reason}` : '';
    return {
      title: 'Trust Score Changed',
      body: `${ctx.userName}'s trust score ${direction} from ${ctx.previousScore} to ${ctx.newScore}${reasonStr}`,
      type: ctx.newScore < ctx.previousScore ? 'warning' : 'info',
    };
  }

  private severityToAppriseType(severity: string): 'info' | 'success' | 'warning' | 'failure' {
    const map: Record<string, 'info' | 'success' | 'warning' | 'failure'> = {
      high: 'failure',
      warning: 'warning',
      low: 'info',
    };
    return map[severity] ?? 'info';
  }

  private async sendWebhook(webhookUrl: string, payload: ApprisePayload): Promise<void> {
    const { url, authHeaders } = this.buildFetchOptions(webhookUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Apprise webhook failed: ${response.status} ${text}`.trim());
    }
  }
}
