import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getManagedPolicy, loadManagedPolicy, type ManagedPolicy } from "./policy";

export function useManagedPolicy(): ManagedPolicy {
  const [policy, setPolicy] = useState<ManagedPolicy>(getManagedPolicy);
  useEffect(() => {
    let active = true;
    void loadManagedPolicy().then((loaded) => {
      if (active) setPolicy(loaded);
    });
    return () => {
      active = false;
    };
  }, []);
  return policy;
}

/** Appends the "managed by your organization" note to a row description. */
export function withManagedNote(
  description: ReactNode,
  managed: boolean,
): ReactNode {
  if (!managed) return description;
  return (
    <>
      {description}
      <ManagedNote />
    </>
  );
}

export function ManagedNote() {
  const { t } = useTranslation();
  return (
    <span className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
      <svg
        className="h-3 w-3 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
        />
      </svg>
      {t("policy.managed")}
    </span>
  );
}
