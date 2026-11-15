// Where an article sends readers next, written before the change from the ways it can go wrong (upstream
// KKKKhazix/AIHOT c595317, the daily part): an article a daily carries does not link to that daily, on wide
// screens or on phones, names its date otherwise than the site names issues, or calls itself the lead of an
// issue that leads with another.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as cheerio from "cheerio";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { ITEM_COPY, withSubject } from "@aihot/site";
import { fakeApi, itemDetail, startWebServer, type WebServer } from "../apps/web/tests/web-server.ts";

const agent = { slug: "agent", name: "Agent 智能体" };
const items: SiteItemDetail[] = [
  itemDetail({ id: "links-lead", title: "日报头条", topics: [agent], daily: { key: "2026-11-07", lead: true } }),
  itemDetail({ id: "links-entry", title: "日报里的一条", daily: { key: "2026-11-07", lead: false } }),
  itemDetail({ id: "links-none", title: "没进日报" }),
];

let web: WebServer;
before(async () => {
  web = await startWebServer(fakeApi((url) => items.find((i) => url.pathname === `/api/site/items/${i.id}`)));
});
after(async () => { await web?.stop(); });

async function page(path: string) {
  const response = await fetch(`${web.origin}${path}`);
  assert.equal(response.status, 200, web.logs());
  return cheerio.load(await response.text());
}

/** The headings of the rail that has `heading`, in order. */
function railOf($: cheerio.CheerioAPI, heading: string): string[] {
  const rail = $("h2").filter((_, el) => $(el).text() === heading).closest("aside");
  assert.equal(rail.length, 1, heading);
  return rail.find("h2").toArray().map((el) => $(el).text());
}

test("an article a daily carries links to that issue, in the rail and first among the phone chips", async () => {
  const daily = withSubject("日报");
  for (const [id, name] of [["links-lead", `11月7日 ${daily} · 头条`], ["links-entry", `11月7日 ${daily}`]] as const) {
    const $ = await page(`/items/${id}`);
    const links = $("a[href='/daily/2026-11-07']");
    // On phones it heads the row of topic and tag chips at the end of the text; wide screens have it in the rail.
    assert.deepEqual(links.toArray().map((el) => $(el).text()), [`收录于 ${name}`, name], id);
    const chip = links.eq(0);
    assert.ok(chip.closest("article").length && chip.is(chip.parent().children().first()), id);
    assert.equal(links.eq(1).closest("section").find("h2").text(), "收录于");
  }
  // Between the reason and the topics.
  assert.deepEqual(railOf(await page("/items/links-lead"), "收录于"), [ITEM_COPY.reasonLabel, "收录于", "主题"]);
  const $ = await page("/items/links-none");
  assert.equal($("a[href^='/daily/2']").length, 0);
  assert.equal($("h2").filter((_, el) => $(el).text() === "收录于").length, 0);
});
