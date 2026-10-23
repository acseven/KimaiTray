import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../shared/i18n";

/**
 * Builds the URL of the signed-in user's Kimai profile. Kimai's `my_profile`
 * route redirects to `/{locale}/profile/{username}`, whose "API Access" tab
 * creates personal access tokens. Returns null for anything that is not a
 * plain http(s) base URL, so credentials or other schemes are never opened.
 */
export function kimaiProfileUrl(baseUrl: string, language: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;

  const locale = (SUPPORTED_LANGUAGES as readonly string[]).includes(language)
    ? (language as SupportedLanguage)
    : "en";
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${basePath}/${locale}/profile/`;
}

interface Props {
  url: string;
  defaultOpen?: boolean;
}

export default function ApiTokenGuide({ url, defaultOpen = false }: Props) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const [openFailed, setOpenFailed] = useState(false);
  const profileUrl = kimaiProfileUrl(url, i18n.language);

  const openProfile = async (target: string) => {
    setOpenFailed(false);
    try {
      await openUrl(target);
    } catch {
      setOpenFailed(true);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-[11px] font-medium text-[var(--accent)] hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
      >
        {t("connection.tokenGuide.toggle")}
      </button>
    );
  }

  const apiTab = t("connection.tokenGuide.kimaiApiTab");
  const create = t("connection.tokenGuide.kimaiCreate");

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-3 text-[12px] text-gray-600 dark:border-gray-800 dark:bg-gray-800/50 dark:text-gray-300">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-gray-700 dark:text-gray-200">
          {t("connection.tokenGuide.title")}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="shrink-0 rounded-md px-2 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
        >
          {t("common.hide")}
        </button>
      </div>
      <ol className="list-decimal space-y-2 pl-4">
        <li>
          <div>{t("connection.tokenGuide.stepOpen")}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => profileUrl && void openProfile(profileUrl)}
              disabled={!profileUrl}
              className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
            >
              {t("connection.tokenGuide.openProfile")}
            </button>
            {!profileUrl && (
              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                {t("connection.tokenGuide.urlFirst")}
              </span>
            )}
            {openFailed && (
              <span className="text-[11px] text-red-500 dark:text-red-400">
                {t("connection.tokenGuide.openFailed")}
              </span>
            )}
          </div>
        </li>
        <li>{t("connection.tokenGuide.stepCreate", { apiTab, create })}</li>
        <li>{t("connection.tokenGuide.stepName")}</li>
        <li>{t("connection.tokenGuide.stepPaste")}</li>
      </ol>
      <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
        {t("connection.tokenGuide.noApiTab", { apiTab })}
      </p>
    </div>
  );
}
