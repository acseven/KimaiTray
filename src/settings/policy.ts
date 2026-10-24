import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types";

/**
 * Settings enforced by an administrator, e.g. through Group Policy
 * (`HKLM\SOFTWARE\Policies\KimaiTray`, then the same key under HKCU). The
 * native side returns the raw registry values; everything is validated here
 * and an invalid value is ignored as if it were not configured.
 */
export interface ManagedPolicy {
  kimaiUrl?: string;
  kimaiUrlLocked?: boolean;
  language?: AppSettings["language"];
  launchAtLogin?: boolean;
  refreshInterval?: number;
  disableUpdates?: boolean;
  enableIdleDetection?: boolean;
  idleThresholdMinutes?: number;
  idleAction?: AppSettings["idleAction"];
  enableNoTimerReminder?: boolean;
  noTimerReminderMinutes?: number;
}

const LANGUAGES = ["sk", "en", "cs", "de", "uk", "pt", "system"] as const;
const REFRESH_INTERVALS = [15, 30, 60, 120, 300, 600];
const IDLE_ACTIONS = ["ask", "stop", "discard", "continue"] as const;

function flag(value: unknown): boolean | undefined {
  if (value === 0 || value === false) return false;
  if (value === 1 || value === true) return true;
  return undefined;
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return value.trim().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function normalizePolicy(raw: unknown): ManagedPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const candidate: ManagedPolicy = {
    kimaiUrl: httpUrl(value.kimaiUrl),
    kimaiUrlLocked: flag(value.kimaiUrlLocked),
    language: oneOf(value.language, LANGUAGES),
    launchAtLogin: flag(value.launchAtLogin),
    refreshInterval: REFRESH_INTERVALS.includes(value.refreshInterval as number)
      ? (value.refreshInterval as number)
      : undefined,
    disableUpdates: flag(value.disableUpdates),
    enableIdleDetection: flag(value.enableIdleDetection),
    idleThresholdMinutes: integer(value.idleThresholdMinutes, 1, 60),
    idleAction: oneOf(value.idleAction, IDLE_ACTIONS),
    enableNoTimerReminder: flag(value.enableNoTimerReminder),
    noTimerReminderMinutes: integer(value.noTimerReminderMinutes, 1, 1440),
  };
  const policy: ManagedPolicy = {};
  for (const [key, item] of Object.entries(candidate)) {
    if (item !== undefined) (policy as Record<string, unknown>)[key] = item;
  }
  // A lock without a server URL has nothing to lock to.
  if (!policy.kimaiUrl) delete policy.kimaiUrlLocked;
  return policy;
}

let currentPolicy: ManagedPolicy = {};
let policyPromise: Promise<ManagedPolicy> | null = null;

/** Reads the policy once per process; policies apply on the next app start. */
export function loadManagedPolicy(): Promise<ManagedPolicy> {
  if (!policyPromise) {
    policyPromise = invoke<unknown>("get_managed_policy")
      .then(normalizePolicy)
      .catch(() => ({}))
      .then((policy) => {
        currentPolicy = policy;
        return policy;
      });
  }
  return policyPromise;
}

/** The policy loaded so far; empty until `loadManagedPolicy` resolves. */
export function getManagedPolicy(): ManagedPolicy {
  return currentPolicy;
}

/** Settings keys whose value is currently enforced by policy. */
export function managedSettingKeys(policy: ManagedPolicy): Set<keyof AppSettings> {
  return new Set(Object.keys(policySettings(policy)) as (keyof AppSettings)[]);
}

function policySettings(policy: ManagedPolicy): Partial<AppSettings> {
  const settings: Partial<AppSettings> = {};
  if (policy.language !== undefined) settings.language = policy.language;
  if (policy.launchAtLogin !== undefined) settings.launchAtLogin = policy.launchAtLogin;
  if (policy.refreshInterval !== undefined) settings.refreshInterval = policy.refreshInterval;
  if (policy.disableUpdates) settings.autoUpdate = false;
  if (policy.enableIdleDetection !== undefined) {
    settings.enableIdleDetection = policy.enableIdleDetection;
  }
  if (policy.idleThresholdMinutes !== undefined) {
    settings.idleThresholdMinutes = policy.idleThresholdMinutes;
  }
  if (policy.idleAction !== undefined) settings.idleAction = policy.idleAction;
  if (policy.enableNoTimerReminder !== undefined) {
    settings.enableNoTimerReminder = policy.enableNoTimerReminder;
  }
  if (policy.noTimerReminderMinutes !== undefined) {
    settings.noTimerReminderMinutes = policy.noTimerReminderMinutes;
  }
  return settings;
}

/** Overlays enforced values without touching the user's stored settings. */
export function applyPolicy(settings: AppSettings, policy: ManagedPolicy): AppSettings {
  return { ...settings, ...policySettings(policy) };
}

/** Test helper: forget the cached policy. */
export function resetManagedPolicyForTests(policy: ManagedPolicy = {}): void {
  currentPolicy = policy;
  policyPromise = Object.keys(policy).length > 0 ? Promise.resolve(policy) : null;
}
