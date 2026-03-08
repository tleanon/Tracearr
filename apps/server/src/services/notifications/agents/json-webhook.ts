/**
 * Generic JSON Webhook Notification Agent
 *
 * Sends raw JSON payloads to custom webhook endpoints.
 */

import { NOTIFICATION_EVENTS } from '@tracearr/shared';
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

interface JsonWebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class JsonWebhookAgent extends BaseAgent {
  readonly name = 'json-webhook';
  readonly displayName = 'JSON Webhook';

  shouldSend(_event: NotificationEventType, settings: NotificationSettings): boolean {
    return (
      !!settings.customWebhookUrl &&
      (settings.webhookFormat === 'json' || settings.webhookFormat === null)
    );
  }

  async send(payload: NotificationPayload, settings: NotificationSettings): Promise<SendResult> {
    if (!settings.customWebhookUrl) {
      return this.handleError(new Error('Custom webhook URL not configured'), 'send');
    }

    try {
      const jsonPayload = this.buildJsonPayload(payload);
      await this.sendWebhook(settings.customWebhookUrl, jsonPayload);
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
      const payload: JsonWebhookPayload = {
        event: 'test',
        timestamp: new Date().toISOString(),
        data: { message: 'This is a test notification from Tracearr' },
      };
      await this.sendWebhook(settings.customWebhookUrl, payload);
      return this.successTestResult();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.failureTestResult(message);
    }
  }

  private buildJsonPayload(payload: NotificationPayload): JsonWebhookPayload {
    switch (payload.context.type) {
      case 'violation_detected':
        return this.buildViolationPayload(payload, payload.context);
      case 'stream_started':
        return this.buildSessionStartedPayload(payload, payload.context);
      case 'stream_stopped':
        return this.buildSessionStoppedPayload(payload, payload.context);
      case 'server_down':
        return this.buildServerPayload(payload, payload.context);
      case 'server_up':
        return this.buildServerPayload(payload, payload.context);
      case 'new_device':
        return this.buildNewDevicePayload(payload, payload.context);
      case 'trust_score_changed':
        return this.buildTrustScoreChangedPayload(payload, payload.context);
    }
  }

  private buildViolationPayload(
    payload: NotificationPayload,
    ctx: ViolationContext
  ): JsonWebhookPayload {
    const { violation } = ctx;
    return {
      event: NOTIFICATION_EVENTS.VIOLATION_DETECTED,
      timestamp: payload.timestamp,
      data: {
        user: {
          id: violation.serverUserId,
          username: violation.user.username,
          displayName: violation.user.identityName ?? violation.user.username,
        },
        rule: {
          id: violation.ruleId,
          type: violation.rule.type,
          name: violation.rule.name,
        },
        violation: {
          id: violation.id,
          severity: violation.severity,
          details: violation.data,
        },
      },
    };
  }

  private buildSessionStartedPayload(
    payload: NotificationPayload,
    ctx: SessionContext
  ): JsonWebhookPayload {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);
    const playbackType = this.getPlaybackType(session);

    return {
      event: NOTIFICATION_EVENTS.STREAM_STARTED,
      timestamp: payload.timestamp,
      data: {
        user: {
          id: session.serverUserId,
          username: session.user.username,
          displayName: this.getUserDisplayName(session),
        },
        media: {
          title: mediaTitle,
          subtitle,
          type: session.mediaType,
          year: session.year,
        },
        playback: {
          type: playbackType,
          quality: session.quality,
          player: session.product || session.playerName,
        },
        location: {
          city: session.geoCity,
          country: session.geoCountry,
        },
      },
    };
  }

  private buildSessionStoppedPayload(
    payload: NotificationPayload,
    ctx: SessionContext
  ): JsonWebhookPayload {
    const { session } = ctx;
    const { title: mediaTitle, subtitle } = this.getMediaDisplay(session);

    return {
      event: NOTIFICATION_EVENTS.STREAM_STOPPED,
      timestamp: payload.timestamp,
      data: {
        user: {
          id: session.serverUserId,
          username: session.user.username,
          displayName: this.getUserDisplayName(session),
        },
        media: {
          title: mediaTitle,
          subtitle,
          type: session.mediaType,
        },
        session: {
          durationMs: session.durationMs,
        },
      },
    };
  }

  private buildServerPayload(payload: NotificationPayload, ctx: ServerContext): JsonWebhookPayload {
    const event =
      ctx.type === 'server_down' ? NOTIFICATION_EVENTS.SERVER_DOWN : NOTIFICATION_EVENTS.SERVER_UP;

    return {
      event,
      timestamp: payload.timestamp,
      data: {
        serverName: ctx.serverName,
        serverType: ctx.serverType,
      },
    };
  }

  private buildNewDevicePayload(
    payload: NotificationPayload,
    ctx: NewDeviceContext
  ): JsonWebhookPayload {
    return {
      event: NOTIFICATION_EVENTS.NEW_DEVICE,
      timestamp: payload.timestamp,
      data: {
        userName: ctx.userName,
        deviceName: ctx.deviceName,
        platform: ctx.platform,
        location: ctx.location,
      },
    };
  }

  private buildTrustScoreChangedPayload(
    payload: NotificationPayload,
    ctx: TrustScoreChangedContext
  ): JsonWebhookPayload {
    return {
      event: NOTIFICATION_EVENTS.TRUST_SCORE_CHANGED,
      timestamp: payload.timestamp,
      data: {
        userName: ctx.userName,
        previousScore: ctx.previousScore,
        newScore: ctx.newScore,
        reason: ctx.reason,
      },
    };
  }

  private async sendWebhook(webhookUrl: string, payload: JsonWebhookPayload): Promise<void> {
    const { url, authHeaders } = this.buildFetchOptions(webhookUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload),
    });
    const text = await response.text().catch(() => '');

    if (!response.ok) {
      throw new Error(`JSON webhook failed: ${response.status} ${text}`.trim());
    }
  }
}
