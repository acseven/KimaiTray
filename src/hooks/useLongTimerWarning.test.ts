// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTimer } from "../types";
import type { LongTimerAction } from "../api/reminderWindow";
import {
  LONG_TIMER_REPEAT_MS,
  LongTimerTracker,
  useLongTimerWarning,
} from "./useLongTimerWarning";

const mocks = vi.hoisted(() => ({
  hideFullscreenReminder: vi.fn(),
  showFullscreenReminder: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  loggerError: vi.fn(),
  tick: null as null | (() => void),
  action: null as null | ((event: { payload: LongTimerAction }) => void),
}));

vi.mock("../api/reminderWindow", () => ({
  hideFullscreenReminder: mocks.hideFullscreenReminder,
  showFullscreenReminder: mocks.showFullscreenReminder,
  LONG_TIMER_ACTION_EVENT: "long-timer-action",
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: mocks.listen }),
}));
vi.mock("../utils/logger", () => ({ logger: { error: mocks.loggerError } }));

const HOUR = 3_600_000;
const NOW = Date.parse("2026-01-02T12:00:00Z");

function timer(id: number, hoursAgo: number): ActiveTimer {
  const beginSeconds = Math.floor((NOW - hoursAgo * HOUR) / 1000);
  return {
    id,
    projectId: 1,
    activityId: 2,
    project: `Project ${id}`,
    projectColor: "",
    activityColor: "",
    customerColor: "",
    activity: "Work",
    description: "",
    tags: [],
    beginSeconds,
    beginIso: new Date(beginSeconds * 1000).toISOString(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.tick = null;
  mocks.action = null;
  mocks.showFullscreenReminder.mockResolvedValue(true);
  mocks.hideFullscreenReminder.mockResolvedValue(undefined);
  mocks.listen.mockImplementation(async (event, callback) => {
    if (event === "kimai://tick") mocks.tick = callback;
    else mocks.action = callback;
    return mocks.unlisten;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LongTimerTracker", () => {
  it("warns after the threshold and then every hour", () => {
    const tracker = new LongTimerTracker();
    const running = [timer(1, 11)];

    expect(tracker.update(NOW, true, 12 * HOUR, running)).toEqual({ action: "none" });
    expect(tracker.delayMs(NOW, true, 12 * HOUR, running)).toBe(60_000);
    expect(tracker.delayMs(NOW + HOUR - 1_000, true, 12 * HOUR, running)).toBe(1_000);

    const due = NOW + HOUR;
    expect(tracker.update(due, true, 12 * HOUR, running)).toEqual({
      action: "show",
      timer: running[0],
    });
    // Visible: no further decisions until it is closed.
    expect(tracker.update(due + 2 * HOUR, true, 12 * HOUR, running)).toEqual({ action: "none" });
    expect(tracker.delayMs(due, true, 12 * HOUR, running)).toBeNull();

    tracker.dismissed();
    expect(tracker.update(due + LONG_TIMER_REPEAT_MS - 1, true, 12 * HOUR, running).action).toBe("none");
    expect(tracker.update(due + LONG_TIMER_REPEAT_MS, true, 12 * HOUR, running).action).toBe("show");
  });

  it("warns about the longest-running timer first and honors snoozes", () => {
    const tracker = new LongTimerTracker();
    const running = [timer(1, 13), timer(2, 20)];

    const first = tracker.update(NOW, true, 12 * HOUR, running);
    expect(first).toEqual({ action: "show", timer: running[1] });
    tracker.snooze(2, NOW, 4 * HOUR);

    expect(tracker.update(NOW, true, 12 * HOUR, running)).toEqual({ action: "show", timer: running[0] });
    tracker.snooze(1, NOW, 2 * HOUR);
    tracker.snooze(9, NOW, HOUR);
    expect(tracker.update(NOW + HOUR, true, 12 * HOUR, running).action).toBe("none");
    expect(tracker.update(NOW + 2 * HOUR, true, 12 * HOUR, running)).toEqual({ action: "show", timer: running[0] });
  });

  it("hides the warning when its timer stops or warnings are turned off", () => {
    const tracker = new LongTimerTracker();
    expect(tracker.update(NOW, true, HOUR, [timer(1, 2)]).action).toBe("show");
    expect(tracker.update(NOW, true, HOUR, [timer(3, 0)])).toEqual({ action: "hide" });
    expect(tracker.update(NOW, true, HOUR, [timer(4, 2)]).action).toBe("show");
    expect(tracker.update(NOW, false, HOUR, [timer(4, 2)])).toEqual({ action: "hide" });
    expect(tracker.update(NOW, false, HOUR, [timer(4, 2)])).toEqual({ action: "none" });
    expect(tracker.delayMs(NOW, false, HOUR, [timer(4, 2)])).toBeNull();
    expect(tracker.delayMs(NOW, true, HOUR, [])).toBeNull();
  });
});

describe("useLongTimerWarning", () => {
  it("shows the warning and stops the timer on request", async () => {
    const stopTimer = vi.fn();
    const running = [timer(7, 12)];
    renderHook(() =>
      useLongTimerWarning({ enabled: true, thresholdHours: 12, timers: running, stopTimer }),
    );
    await act(async () => {});

    expect(mocks.showFullscreenReminder).toHaveBeenCalledWith({
      kind: "longTimer",
      timesheetId: 7,
      project: "Project 7",
      activity: "Work",
      beginIso: running[0].beginIso,
      runningSeconds: 12 * 3600,
    });

    act(() => mocks.action?.({ payload: { action: "stop", timesheetId: 7 } }));
    expect(stopTimer).toHaveBeenCalledWith(running[0]);
    act(() => mocks.action?.({ payload: { action: "stop", timesheetId: 99 } }));
    expect(stopTimer).toHaveBeenCalledTimes(1);
  });

  it("snoozes, repeats after dismissal and hides when disabled", async () => {
    const running = [timer(7, 13)];
    const { rerender, unmount } = renderHook(
      ({ enabled }) =>
        useLongTimerWarning({ enabled, thresholdHours: 12, timers: running, stopTimer: vi.fn() }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {});
    expect(mocks.showFullscreenReminder).toHaveBeenCalledTimes(1);

    act(() => mocks.action?.({ payload: { action: "snooze", timesheetId: 7, hours: 2 } }));
    act(() => {
      vi.advanceTimersByTime(HOUR);
      mocks.tick?.();
    });
    expect(mocks.showFullscreenReminder).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(HOUR);
    });
    expect(mocks.showFullscreenReminder).toHaveBeenCalledTimes(2);

    act(() => mocks.action?.({ payload: { action: "dismissed", timesheetId: 7 } }));
    await act(async () => {
      vi.advanceTimersByTime(HOUR);
    });
    expect(mocks.showFullscreenReminder).toHaveBeenCalledTimes(3);

    rerender({ enabled: false });
    await act(async () => {});
    expect(mocks.hideFullscreenReminder).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {});
    expect(mocks.unlisten).toHaveBeenCalledTimes(2);
  });

  it("logs failures to show or hide the warning", async () => {
    mocks.showFullscreenReminder.mockRejectedValue(new Error("no window"));
    mocks.hideFullscreenReminder.mockRejectedValue(new Error("gone"));
    const { rerender } = renderHook(
      ({ enabled }) =>
        useLongTimerWarning({ enabled, thresholdHours: 1, timers: [timer(3, 2)], stopTimer: vi.fn() }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {});
    rerender({ enabled: false });
    await act(async () => {});
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining("no window"));
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining("gone"));
  });
});
