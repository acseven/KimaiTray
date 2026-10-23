// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import i18n, { initPromise } from "../shared/i18n";
import ApiTokenGuide, { kimaiProfileUrl } from "./ApiTokenGuide";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

beforeAll(async () => {
  await initPromise;
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.openUrl.mockResolvedValue(undefined);
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

function renderGuide(url: string, defaultOpen?: boolean) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ApiTokenGuide url={url} defaultOpen={defaultOpen} />
    </I18nextProvider>,
  );
}

describe("kimaiProfileUrl", () => {
  it("points at the localized own-profile route, keeping a base path", () => {
    expect(kimaiProfileUrl("https://kimai.example.test", "de")).toBe(
      "https://kimai.example.test/de/profile/",
    );
    expect(kimaiProfileUrl(" https://example.test/kimai// ", "sk")).toBe(
      "https://example.test/kimai/sk/profile/",
    );
  });

  it("falls back to English for languages Kimai is not opened in", () => {
    expect(kimaiProfileUrl("http://kimai.local:8001/", "fr")).toBe(
      "http://kimai.local:8001/en/profile/",
    );
  });

  it("rejects invalid, non-http and credential-bearing URLs", () => {
    expect(kimaiProfileUrl("", "en")).toBeNull();
    expect(kimaiProfileUrl("kimai.example.test", "en")).toBeNull();
    expect(kimaiProfileUrl("file:///etc/passwd", "en")).toBeNull();
    expect(kimaiProfileUrl("https://user:pw@kimai.example.test", "en")).toBeNull();
  });
});

describe("ApiTokenGuide", () => {
  it("starts collapsed and expands and hides on request", async () => {
    const user = userEvent.setup();
    renderGuide("https://kimai.example.test");

    expect(screen.queryByText("Get your API token")).toBeNull();
    await user.click(screen.getByRole("button", { name: "How do I get a token?" }));
    expect(screen.getByText("Get your API token")).toBeTruthy();
    expect(
      screen.getByText("Go to the “API Access” tab and click “Create”."),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("Get your API token")).toBeNull();
  });

  it("opens the localized Kimai profile in the browser", async () => {
    await i18n.changeLanguage("cs");
    const user = userEvent.setup();
    renderGuide("https://kimai.example.test/", true);

    expect(
      screen.getByText("Přejděte na kartu „Přístup k API“ a klikněte na „Vytvořit“."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Otevřít můj profil v Kimai" }));
    expect(mocks.openUrl).toHaveBeenCalledWith("https://kimai.example.test/cs/profile/");
  });

  it("asks for the URL first when it is not usable", () => {
    renderGuide("", true);

    const button = screen.getByRole("button", { name: "Open my Kimai profile" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Enter your Kimai URL above first.")).toBeTruthy();
  });

  it("reports when the browser cannot be opened", async () => {
    mocks.openUrl.mockRejectedValueOnce(new Error("denied"));
    const user = userEvent.setup();
    renderGuide("https://kimai.example.test", true);

    await user.click(screen.getByRole("button", { name: "Open my Kimai profile" }));
    expect(await screen.findByText("Could not open the browser.")).toBeTruthy();
  });
});
