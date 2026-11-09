import { defineWebModule } from "@aihot/web/modules";
import { IconChart, IconClock, IconTrendUp } from "@aihot/web/components/icons";
import { codexResetEnabled, githubTrendEnabled } from "./flags.ts";

// 「模型」只是这一段现成的位置。GitHub 趋势不是模型榜，排在 AA 模型榜下面。
export default defineWebModule({
  name: "mafi-readers",
  sidebar: { section: "模型", items: [
    { to: "/leaderboard", label: "AA 模型榜", icon: IconChart },
    { to: "/github-trending", label: "GitHub 趋势", icon: IconTrendUp, flag: "githubTrend" },
    { to: "/codex-reset", label: "Tibo 重置监控", icon: IconClock, flag: "codexReset" },
  ] },
  tabs: [{ key: "models", to: "/leaderboard", label: "模型榜", icon: IconChart }],
  tools: [
    { to: "/github-trending", label: "GitHub 趋势", icon: <IconTrendUp size={18} />, flag: "githubTrend" },
    { to: "/codex-reset", label: "Tibo 重置监控", icon: <IconClock size={18} />, flag: "codexReset" },
  ],
  // Read on the server by the root loader: the entries above with a flag show only while it is true.
  root: { flags: () => ({ codexReset: codexResetEnabled(), githubTrend: githubTrendEnabled() }) },
  agent: () => import("./web/agent.tsx"),
});
