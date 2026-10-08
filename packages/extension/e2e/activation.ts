import { expect } from "@playwright/test";
import { z } from "zod";

import type { Page } from "@playwright/test";

const targetsSchema = z.object({
  targetInfos: z.array(
    z.object({
      targetId: z.string(),
      type: z.string(),
      url: z.string(),
      embedderData: z.object({ tabActive: z.boolean() }).optional(),
    })
  ),
});

/** Exercise Chrome's action and real activeTab grant rather than mocking access. */
export async function activateConnect(
  page: Page,
  id: string,
  manager: Page
): Promise<void> {
  await page.bringToFront();
  const browser = page.context().browser();
  if (!browser) throw new Error("Missing Chromium browser");
  const actions = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = targetsSchema.parse(
      await actions.send("Target.getTargets", { filter: [{}] })
    );
    const targets = targetInfos.filter(
      (target) =>
        target.type === "tab" &&
        target.url === page.url() &&
        target.embedderData?.tabActive
    );
    const target = targets[0];
    if (!target || targets.length !== 1)
      throw new Error("Missing unique active Chromium tab");
    await actions.send("Extensions.triggerAction", {
      id,
      targetId: target.targetId,
    });
    // Chrome's popup is not a Playwright Page. Read its actual UI through the
    // same-origin manager without activating another tab or bypassing grants.
    await expect
      .poll(() =>
        manager.evaluate(
          () =>
            chrome.extension
              .getViews({ type: "popup" })
              .find((view) => view.location.search === "?view=popup")
              ?.document.querySelector(".site-connection")?.textContent
        )
      )
      .toContain(`Ready for ${new URL(page.url()).host}`);
    await expect
      .poll(() => page.evaluate(() => Boolean(window.rujira)))
      .toBe(true);
    // Toolbar popups are CDP "other" targets, not Playwright Page objects.
    const popup = targetsSchema
      .parse(await actions.send("Target.getTargets", { filter: [{}] }))
      .targetInfos.find(
        (candidate) =>
          candidate.url === `chrome-extension://${id}/index.html?view=popup`
      );
    if (!popup) throw new Error("Missing Connect toolbar popup");
    await actions.send("Target.closeTarget", { targetId: popup.targetId });
  } finally {
    await actions.detach();
  }
}
