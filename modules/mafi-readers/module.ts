import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "mafi-readers",
  pages: [
    { path: "codex-reset", file: "web/codex-reset.tsx", id: "mafi-codex-reset" },
    { path: "leaderboard", file: "web/aa-models.tsx", id: "mafi-aa-models" },
    { path: "github-trending", file: "web/github-trend.tsx", id: "mafi-github-trend" },
  ],
  apiPaths: [
    /^\/api\/mafi-readers\/(?:codex-resets|aa-models|github-trending)$/,
    /^\/api\/mafi-readers\/aa-models\/refresh$/,
    /^\/api\/admin\/mafi-readers\/github-trending\/refresh$/,
  ],
});
