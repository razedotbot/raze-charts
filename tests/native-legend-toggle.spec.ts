import { expect, test, type Page } from "@playwright/test";

// The mounted native legend has one interactive element and one pointer
// target per entry, on both renderers: mouse and touch hit the painted entry
// (the SVG row or the Canvas pixels) and the transparent toggle button over it
// serves the keyboard and screen readers without intercepting the pointer.
// Regression: the merged W1B-02/W1B-03 mount stacked a pointer-hit button over
// each clickable SVG row, so the row itself could not be clicked.

type Renderer = "svg" | "canvas";

async function openLegend(page: Page, query: string): Promise<void> {
  await page.goto(`/tests/fixtures/native-legend.html?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __razeLegendReady?: boolean }).__razeLegendReady === true);
  await page.evaluate(() => document.fonts.ready);
}

interface EntryPoint { id: string; x: number; y: number }

/** Page coordinates of the centre of every painted legend entry, from the scene's row boxes. */
function entryPoints(page: Page): Promise<EntryPoint[]> {
  return page.evaluate(() => {
    const handle = (window as unknown as {
      __razeHandle: { getScene(): { legendLayout: { rows: { id: string; box?: { x: number; y: number; w: number; h: number } }[] } } };
    }).__razeHandle;
    const host = document.getElementById("host")!.getBoundingClientRect();
    return handle.getScene().legendLayout.rows.filter((row) => row.box).map((row) => ({
      id: row.id,
      x: host.x + row.box!.x + row.box!.w / 2,
      y: host.y + row.box!.y + row.box!.h / 2,
    }));
  });
}

function hiddenIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const handle = (window as unknown as { __razeHandle: { getScene(): { legendLayout: { rows: { id: string; hidden: boolean }[] } } } }).__razeHandle;
    return handle.getScene().legendLayout.rows.filter((row) => row.hidden).map((row) => row.id);
  });
}

const toggle = (page: Page, id: string) => page.locator(`#host button[data-series="${id}"]`);

for (const renderer of ["svg", "canvas"] as Renderer[]) {
  test.describe(`native legend toggles (${renderer})`, () => {
    test("each entry has one pointer target and one interactive element", async ({ page }) => {
      await openLegend(page, `case=series&renderer=${renderer}`);
      const points = await entryPoints(page);
      expect(points).toHaveLength(12);
      const hits = await page.evaluate((list) => list.map(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        const stage = document.querySelector("#host svg, #host canvas");
        return {
          inStage: !!hit && !!stage && (hit === stage || stage.contains(hit)),
          row: hit?.closest("svg [data-series]")?.getAttribute("data-series") ?? null,
          cursor: hit ? getComputedStyle(hit).cursor : "",
        };
      }), points);
      for (const [i, hit] of hits.entries()) {
        expect(hit.inStage, `entry ${points[i]!.id} is hit on the painted legend, not on a button over it`).toBe(true);
        if (renderer === "svg") expect(hit.row).toBe(points[i]!.id);
      }
      // Exactly one focusable control per entry: the named toggle button.
      const focusable = page.locator("#host button, #host [tabindex], #host [role='button'], #host a[href]");
      await expect(focusable).toHaveCount(12);
      const group = page.getByRole("group", { name: "Series" });
      await expect(group.getByRole("button")).toHaveCount(12);
      await expect(group.getByRole("button", { name: "Portfolio 1", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#host svg [data-series][tabindex], #host svg [data-series][role]")).toHaveCount(0);
    });

    test("the mouse toggles the entry under it and shows the pointer cursor there", async ({ page }) => {
      await openLegend(page, `case=series&renderer=${renderer}`);
      const [first, second] = await entryPoints(page);
      const cursorAt = async (x: number, y: number) => {
        await page.mouse.move(x, y);
        return page.evaluate(([px, py]) => getComputedStyle(document.elementFromPoint(px!, py!)!).cursor, [x, y]);
      };
      expect(await cursorAt(first!.x, first!.y)).toBe("pointer");
      const host = (await page.locator("#host").boundingBox())!;
      expect(await cursorAt(host.x + host.width / 2, host.y + host.height / 2)).not.toBe("pointer");

      await page.mouse.click(second!.x, second!.y);
      expect(await hiddenIds(page)).toEqual([second!.id]);
      await expect(toggle(page, second!.id)).toHaveAttribute("aria-pressed", "false");
      await page.mouse.click(second!.x, second!.y);
      expect(await hiddenIds(page)).toEqual([]);
      await expect(toggle(page, second!.id)).toHaveAttribute("aria-pressed", "true");
    });

    test("Enter and Space on a focused toggle hide and show its series", async ({ page }) => {
      await openLegend(page, `case=hidden&renderer=${renderer}`);
      const button = page.getByRole("button", { name: "Portfolio 2", exact: true });
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      expect(await hiddenIds(page)).toEqual(["mark-4"]);
      await expect(button).toBeFocused();
      await page.keyboard.press("Space");
      await expect(button).toHaveAttribute("aria-pressed", "false");
      expect((await hiddenIds(page)).sort()).toEqual(["mark-1", "mark-4"]);
      // Tab moves on to the next series' toggle.
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Portfolio 3", exact: true })).toBeFocused();
    });
  });

  test.describe(`native legend toggles by touch (${renderer})`, () => {
    test.use({ hasTouch: true });

    test("a tap toggles a series and a pie slice", async ({ page }) => {
      await openLegend(page, `case=series&renderer=${renderer}`);
      const [, , third] = await entryPoints(page);
      await page.touchscreen.tap(third!.x, third!.y);
      expect(await hiddenIds(page)).toEqual([third!.id]);
      await expect(toggle(page, third!.id)).toHaveAttribute("aria-pressed", "false");
      await page.touchscreen.tap(third!.x, third!.y);
      expect(await hiddenIds(page)).toEqual([]);

      await openLegend(page, `case=pie&renderer=${renderer}`);
      const [slice] = await entryPoints(page);
      await page.touchscreen.tap(slice!.x, slice!.y);
      expect(await hiddenIds(page)).toEqual([slice!.id]);
      await expect(toggle(page, slice!.id)).toHaveAttribute("aria-pressed", "false");
    });
  });
}
