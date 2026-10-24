import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "./service";
import admx from "../../deploy/gpo/KimaiTray.admx?raw";
import admlEn from "../../deploy/gpo/en-US/KimaiTray.adml?raw";
import admlPt from "../../deploy/gpo/pt-PT/KimaiTray.adml?raw";
import rust from "../../src-tauri/src/policy.rs?raw";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  applyPolicy,
  getManagedPolicy,
  loadManagedPolicy,
  managedSettingKeys,
  normalizePolicy,
  resetManagedPolicyForTests,
} from "./policy";

afterEach(() => {
  resetManagedPolicyForTests();
  mocks.invoke.mockReset();
});

describe("normalizePolicy", () => {
  it("keeps valid values and converts registry flags", () => {
    expect(
      normalizePolicy({
        kimaiUrl: " https://kimai.example.test/ ",
        kimaiUrlLocked: 1,
        language: "pt",
        launchAtLogin: 0,
        refreshInterval: 300,
        disableUpdates: 1,
        enableIdleDetection: true,
        idleThresholdMinutes: 10,
        idleAction: "stop",
        enableNoTimerReminder: false,
        noTimerReminderMinutes: 30,
      }),
    ).toEqual({
      kimaiUrl: "https://kimai.example.test",
      kimaiUrlLocked: true,
      language: "pt",
      launchAtLogin: false,
      refreshInterval: 300,
      disableUpdates: true,
      enableIdleDetection: true,
      idleThresholdMinutes: 10,
      idleAction: "stop",
      enableNoTimerReminder: false,
      noTimerReminderMinutes: 30,
    });
  });

  it("ignores invalid values as if they were not configured", () => {
    expect(
      normalizePolicy({
        kimaiUrl: "ftp://kimai.example.test",
        kimaiUrlLocked: 1,
        language: "fr",
        launchAtLogin: 2,
        refreshInterval: 45,
        idleThresholdMinutes: 61,
        idleAction: "sleep",
        noTimerReminderMinutes: 1.5,
        unknown: "value",
      }),
    ).toEqual({});
    expect(normalizePolicy({ kimaiUrl: "https://user:pw@kimai.example.test" })).toEqual({});
    expect(normalizePolicy({ kimaiUrl: "not a url" })).toEqual({});
    expect(normalizePolicy({ kimaiUrl: 42 })).toEqual({});
    expect(normalizePolicy(null)).toEqual({});
    expect(normalizePolicy([])).toEqual({});
  });
});

describe("applyPolicy", () => {
  it("overrides only the enforced settings", () => {
    const policy = normalizePolicy({
      language: "de",
      launchAtLogin: 1,
      refreshInterval: 15,
      disableUpdates: 1,
      enableIdleDetection: 1,
      idleThresholdMinutes: 3,
      idleAction: "discard",
      enableNoTimerReminder: 1,
      noTimerReminderMinutes: 45,
      kimaiUrl: "https://kimai.example.test",
    });
    const settings = applyPolicy({ ...defaultSettings, theme: "dark" }, policy);
    expect(settings).toMatchObject({
      theme: "dark",
      language: "de",
      launchAtLogin: true,
      refreshInterval: 15,
      autoUpdate: false,
      enableIdleDetection: true,
      idleThresholdMinutes: 3,
      idleAction: "discard",
      enableNoTimerReminder: true,
      noTimerReminderMinutes: 45,
    });
    expect([...managedSettingKeys(policy)].sort()).toEqual([
      "autoUpdate",
      "enableIdleDetection",
      "enableNoTimerReminder",
      "idleAction",
      "idleThresholdMinutes",
      "language",
      "launchAtLogin",
      "noTimerReminderMinutes",
      "refreshInterval",
    ]);
  });

  it("leaves updates alone unless they are disabled", () => {
    const policy = normalizePolicy({ disableUpdates: 0 });
    expect(applyPolicy(defaultSettings, policy).autoUpdate).toBe(true);
    expect(managedSettingKeys(policy).size).toBe(0);
  });
});

describe("loadManagedPolicy", () => {
  it("reads the native policy once and caches it", async () => {
    mocks.invoke.mockResolvedValue({ language: "pt" });
    await expect(loadManagedPolicy()).resolves.toEqual({ language: "pt" });
    await loadManagedPolicy();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("get_managed_policy");
    expect(getManagedPolicy()).toEqual({ language: "pt" });
  });

  it("treats an unavailable policy as empty", async () => {
    mocks.invoke.mockRejectedValue(new Error("unsupported"));
    await expect(loadManagedPolicy()).resolves.toEqual({});
  });

  it("can be seeded for tests", async () => {
    resetManagedPolicyForTests({ disableUpdates: true });
    await expect(loadManagedPolicy()).resolves.toEqual({ disableUpdates: true });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("Group Policy templates", () => {
  const ids = (text: string, pattern: RegExp) =>
    [...text.matchAll(pattern)].map((match) => match[1]).sort();

  it("writes exactly the registry values the app reads", () => {
    const written = [...new Set(ids(admx, /valueName="([^"]+)"/g))].sort();
    const read = ids(rust, /\("([A-Za-z]+)", "[A-Za-z]+", Kind::/g);
    expect(written).toEqual(read);
  });

  it.each([
    ["en-US", admlEn],
    ["pt-PT", admlPt],
  ])("has every string and presentation in %s", (_culture, adml) => {
    const strings = new Set(ids(adml, /<string id="([^"]+)"/g));
    const presentations = new Set(ids(adml, /<presentation id="([^"]+)"/g));
    for (const id of ids(admx, /\$\(string\.([^)]+)\)/g)) expect(strings).toContain(id);
    for (const id of ids(admx, /\$\(presentation\.([^)]+)\)/g)) {
      expect(presentations).toContain(id);
    }
    const elementIds = ids(admx, /<(?:text|boolean|enum|decimal) id="([^"]+)"/g);
    const refIds = ids(adml, /refId="([^"]+)"/g);
    expect(refIds).toEqual(elementIds);
  });
});
