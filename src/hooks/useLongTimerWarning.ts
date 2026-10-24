import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  hideFullscreenReminder,
  LONG_TIMER_ACTION_EVENT,
  showFullscreenReminder,
  type LongTimerAction,
} from "../api/reminderWindow";
import type { ActiveTimer } from "../types";
import { logger } from "../utils/logger";

/** A warning that was not dismissed comes back after this long. */
export const LONG_TIMER_REPEAT_MS = 60 * 60_000;
/** Re-evaluate at least this often, so sleep or clock changes are noticed. */
const MAX_CHECK_DELAY_MS = 60_000;

export type LongTimerDecision =
  | { action: "show"; timer: ActiveTimer }
  | { action: "hide" }
  | { action: "none" };

/**
 * Decides when a running timer has been running for too long. Each timer is
 * first due after the threshold, then once an hour, or after the period the
 * user chose when dismissing the warning.
 */
export class LongTimerTracker {
  private nextDue = new Map<number, number>();
  private shownId: number | null = null;

  update(
    now: number,
    enabled: boolean,
    thresholdMs: number,
    timers: ActiveTimer[],
  ): LongTimerDecision {
    const running = new Set(timers.map((timer) => timer.id));
    for (const id of this.nextDue.keys()) {
      if (!running.has(id)) this.nextDue.delete(id);
    }
    if (!enabled) {
      this.nextDue.clear();
      const wasShown = this.shownId != null;
      this.shownId = null;
      return wasShown ? { action: "hide" } : { action: "none" };
    }
    if (this.shownId != null) {
      if (running.has(this.shownId)) return { action: "none" };
      // The timer was stopped elsewhere while its warning was visible.
      this.shownId = null;
      return { action: "hide" };
    }

    const due = timers
      .filter((timer) => now >= this.dueAt(timer, thresholdMs))
      .sort((left, right) => left.beginSeconds - right.beginSeconds);
    if (due.length === 0) return { action: "none" };

    const timer = due[0];
    this.shownId = timer.id;
    this.nextDue.set(timer.id, now + LONG_TIMER_REPEAT_MS);
    return { action: "show", timer };
  }

  /** Hides the warning and postpones the next one for this timer. */
  snooze(id: number, now: number, durationMs: number): void {
    this.nextDue.set(id, now + durationMs);
    if (this.shownId === id) this.shownId = null;
  }

  /** The warning window was closed without choosing a period. */
  dismissed(): void {
    this.shownId = null;
  }

  delayMs(now: number, enabled: boolean, thresholdMs: number, timers: ActiveTimer[]): number | null {
    if (!enabled || timers.length === 0 || this.shownId != null) return null;
    const next = Math.min(...timers.map((timer) => this.dueAt(timer, thresholdMs)));
    return Math.min(MAX_CHECK_DELAY_MS, Math.max(1, next - now));
  }

  private dueAt(timer: ActiveTimer, thresholdMs: number): number {
    const firstDue = timer.beginSeconds * 1000 + thresholdMs;
    return Math.max(firstDue, this.nextDue.get(timer.id) ?? 0);
  }
}

interface UseLongTimerWarningOptions {
  enabled: boolean;
  thresholdHours: number;
  timers: ActiveTimer[];
  stopTimer: (timer: ActiveTimer) => void;
}

export function useLongTimerWarning({
  enabled,
  thresholdHours,
  timers,
  stopTimer,
}: UseLongTimerWarningOptions) {
  const trackerRef = useRef(new LongTimerTracker());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef({ enabled, thresholdHours, timers, stopTimer });
  optionsRef.current = { enabled, thresholdHours, timers, stopTimer };

  const evaluate = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const now = Date.now();
    const options = optionsRef.current;
    const thresholdMs = options.thresholdHours * 3_600_000;
    const decision = trackerRef.current.update(
      now,
      options.enabled,
      thresholdMs,
      options.timers,
    );

    if (decision.action === "show") {
      const { timer } = decision;
      void showFullscreenReminder({
        kind: "longTimer",
        timesheetId: timer.id,
        project: timer.project,
        activity: timer.activity,
        beginIso: timer.beginIso,
        runningSeconds: Math.max(0, Math.floor(now / 1000) - timer.beginSeconds),
      }).catch((error) => {
        logger.error(`Failed to show long timer warning: ${String(error)}`);
      });
    } else if (decision.action === "hide") {
      void hideFullscreenReminder().catch((error) => {
        logger.error(`Failed to hide long timer warning: ${String(error)}`);
      });
    }

    const delay = trackerRef.current.delayMs(
      now,
      options.enabled,
      thresholdMs,
      options.timers,
    );
    if (delay != null) timeoutRef.current = setTimeout(evaluate, delay);
  }, []);

  useEffect(() => {
    evaluate();
  }, [enabled, thresholdHours, timers, evaluate]);

  useEffect(() => {
    const window = getCurrentWindow();
    const unlistenTick = window.listen("kimai://tick", evaluate);
    const unlistenAction = window.listen<LongTimerAction>(
      LONG_TIMER_ACTION_EVENT,
      ({ payload }) => {
        const tracker = trackerRef.current;
        if (payload.action === "stop") {
          const timer = optionsRef.current.timers.find(
            (running) => running.id === payload.timesheetId,
          );
          tracker.snooze(payload.timesheetId, Date.now(), LONG_TIMER_REPEAT_MS);
          if (timer) optionsRef.current.stopTimer(timer);
        } else if (payload.action === "snooze") {
          tracker.snooze(payload.timesheetId, Date.now(), payload.hours * 3_600_000);
        } else {
          tracker.dismissed();
        }
        evaluate();
      },
    );
    return () => {
      unlistenTick.then((cleanup) => cleanup());
      unlistenAction.then((cleanup) => cleanup());
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [evaluate]);
}
