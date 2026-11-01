import type { ServerModule } from "@aihot/backend/modules";
import type { HotResponse, PoolResponse, SiteItemDetail, TimelineResponse } from "@aihot/contracts/site";
import { registerReactionRoutes } from "./backend/http.ts";
import { readDeviceId } from "./backend/identity.ts";
import { readSourceCounts, readVotes } from "./backend/store.ts";
import { setSelectedSourceQuotaProvider } from "@aihot/backend/publication/timeline";
import { sourceQuotaMultipliers } from "./backend/quota.ts";
import {
  projectHot,
  projectPool,
  projectTimeline,
  type ReaderCandidate,
} from "./backend/views.ts";

/**
 * Preference helpers live on this module object; apps/api locates the installed
 * module by name and casts to this shape (engine never imports mafi-preferences).
 */
export interface PreferenceServerModule extends ServerModule {
  resolveDevice(cookieHeader: string | undefined): Promise<{ deviceId: string } | null>;
  personalizePool(data: PoolResponse, candidates: readonly ReaderCandidate[], deviceId: string): Promise<PoolResponse>;
  personalizeTimeline(data: TimelineResponse, candidates: readonly ReaderCandidate[], deviceId: string): Promise<TimelineResponse>;
  personalizeHot(data: HotResponse, candidates: readonly ReaderCandidate[], deviceId: string): Promise<HotResponse>;
  personalizeItem(item: SiteItemDetail, deviceId: string): Promise<SiteItemDetail>;
}

async function votesAndCounts(deviceId: string, candidates: readonly ReaderCandidate[]) {
  const itemIds = candidates.map((c) => c.itemId);
  const sourceIds = [...new Set(candidates.map((c) => c.sourceId))];
  const [votes, counts] = await Promise.all([
    readVotes(deviceId, itemIds),
    readSourceCounts(deviceId, sourceIds),
  ]);
  return { votes, counts };
}

export function createPreferenceServer(): PreferenceServerModule {
  return {
    name: "mafi-preferences",
    http(app) {
      app.addHook("onRequest", async (request, reply) => {
        if (request.url.split("?")[0] === "/api/site/reactions") {
          reply.header("Cache-Control", "private, no-store");
          reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
        }
      });
      registerReactionRoutes(app);
      // 👍/👎 scale each source's 精选 quota (global, decayed); they never reorder any list.
      setSelectedSourceQuotaProvider(sourceQuotaMultipliers);
    },
    async resolveDevice(cookieHeader) {
      const deviceId = readDeviceId(cookieHeader);
      return deviceId ? { deviceId } : null;
    },
    async personalizePool(data, candidates, deviceId) {
      const { votes, counts } = await votesAndCounts(deviceId, candidates);
      return projectPool(data, candidates, votes, counts);
    },
    async personalizeTimeline(data, candidates, deviceId) {
      const { votes, counts } = await votesAndCounts(deviceId, candidates);
      return projectTimeline(data, candidates, votes, counts);
    },
    async personalizeHot(data, candidates, deviceId) {
      const { votes, counts } = await votesAndCounts(deviceId, candidates);
      return projectHot(data, candidates, votes, counts);
    },
    async personalizeItem(item, deviceId) {
      const votes = await readVotes(deviceId, [item.id]);
      return { ...item, myVote: votes.get(item.id) ?? null };
    },
  };
}

export default createPreferenceServer();
