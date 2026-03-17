import { describe, it, expect } from 'vitest';
import {
  isPlaybackConfirmed,
  createInitialConfirmationState,
  updateConfirmationState,
} from '../stateTracker.js';
import { PLAYBACK_CONFIRM_THRESHOLD_MS } from '../types.js';

describe('isPlaybackConfirmed', () => {
  const baseState = {
    rulesEvaluated: false,
    confirmedPlayback: false,
    firstSeenAt: Date.now(),
    maxViewOffset: 0,
  };

  it('returns true if already confirmed', () => {
    const state = { ...baseState, confirmedPlayback: true };
    expect(isPlaybackConfirmed(state, 0, 'playing', Date.now())).toBe(true);
  });

  it('returns true if viewOffset exceeds threshold', () => {
    const state = { ...baseState };
    expect(
      isPlaybackConfirmed(state, PLAYBACK_CONFIRM_THRESHOLD_MS + 1, 'playing', Date.now())
    ).toBe(true);
  });

  it('returns false if viewOffset equals threshold', () => {
    const state = { ...baseState };
    expect(isPlaybackConfirmed(state, PLAYBACK_CONFIRM_THRESHOLD_MS, 'playing', Date.now())).toBe(
      false
    );
  });

  it('returns true if active duration exceeds threshold while playing', () => {
    const now = Date.now();
    const state = { ...baseState, firstSeenAt: now - PLAYBACK_CONFIRM_THRESHOLD_MS - 1 };
    expect(isPlaybackConfirmed(state, 0, 'playing', now)).toBe(true);
  });

  it('returns false if active duration equals threshold', () => {
    const now = Date.now();
    const state = { ...baseState, firstSeenAt: now - PLAYBACK_CONFIRM_THRESHOLD_MS };
    expect(isPlaybackConfirmed(state, 0, 'playing', now)).toBe(false);
  });

  it('returns true if active duration exceeds threshold while paused', () => {
    const now = Date.now();
    const state = { ...baseState, firstSeenAt: now - PLAYBACK_CONFIRM_THRESHOLD_MS - 1 };
    expect(isPlaybackConfirmed(state, 0, 'paused', now)).toBe(true);
  });

  it('returns false for new session with no progress', () => {
    const state = { ...baseState };
    expect(isPlaybackConfirmed(state, 0, 'playing', Date.now())).toBe(false);
  });

  // Explicit 30s threshold tests (not 60s CONTINUED_SESSION_THRESHOLD_MS)
  it('should confirm playback at 31s wall-clock time (30s threshold)', () => {
    const state = createInitialConfirmationState(0);
    const thirtyOneSeconds = 31_000;

    expect(isPlaybackConfirmed(state, 0, 'playing', thirtyOneSeconds)).toBe(true);
  });

  it('should not confirm at 29s wall-clock time (30s threshold)', () => {
    const state = createInitialConfirmationState(0);
    const twentyNineSeconds = 29_000;

    expect(isPlaybackConfirmed(state, 0, 'playing', twentyNineSeconds)).toBe(false);
  });

  it('should confirm playback at 31s viewOffset (30s threshold)', () => {
    const state = createInitialConfirmationState(Date.now());
    const thirtyOneSecondsOffset = 31_000;

    expect(isPlaybackConfirmed(state, thirtyOneSecondsOffset, 'playing', Date.now())).toBe(true);
  });

  it('should not confirm at 29s viewOffset (30s threshold)', () => {
    const state = createInitialConfirmationState(Date.now());
    const twentyNineSecondsOffset = 29_000;

    expect(isPlaybackConfirmed(state, twentyNineSecondsOffset, 'playing', Date.now())).toBe(false);
  });

  it('uses PLAYBACK_CONFIRM_THRESHOLD_MS (30s), not CONTINUED_SESSION_THRESHOLD_MS (60s)', () => {
    // This test verifies the function uses 30s, not 60s
    // If it used 60s, 31s would NOT confirm but 61s would
    const state = createInitialConfirmationState(0);

    // 31s should confirm with 30s threshold
    expect(isPlaybackConfirmed(state, 0, 'playing', 31_000)).toBe(true);

    // 59s would also confirm with 30s threshold (but NOT with 60s threshold)
    expect(isPlaybackConfirmed(state, 0, 'playing', 59_000)).toBe(true);
  });
});

describe('createInitialConfirmationState', () => {
  it('creates state with correct initial values', () => {
    const now = Date.now();
    const state = createInitialConfirmationState(now);
    expect(state).toEqual({
      rulesEvaluated: false,
      confirmedPlayback: false,
      firstSeenAt: now,
      maxViewOffset: 0,
    });
  });
});

describe('updateConfirmationState', () => {
  it('updates maxViewOffset when higher', () => {
    const state = {
      rulesEvaluated: false,
      confirmedPlayback: false,
      firstSeenAt: Date.now(),
      maxViewOffset: 1000,
    };
    const updated = updateConfirmationState(state, 5000);
    expect(updated.maxViewOffset).toBe(5000);
  });

  it('does not decrease maxViewOffset', () => {
    const state = {
      rulesEvaluated: false,
      confirmedPlayback: false,
      firstSeenAt: Date.now(),
      maxViewOffset: 5000,
    };
    const updated = updateConfirmationState(state, 1000);
    expect(updated.maxViewOffset).toBe(5000);
  });
});
