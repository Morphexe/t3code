import { KanbanStore } from "./kanban";
import { Logger } from "./logger";
import { Orchestrator } from "./orchestrator";
import { serveBoard } from "./server";
import { RealtimeHub } from "./realtime";
import { setPlannerRealtimeHub } from "./planner";
import { ensureProjectOrchestrationFiles } from "./storage";

const args = parseArgs(process.argv.slice(2));
const logger = new Logger();
const storage = await ensureProjectOrchestrationFiles({ projectRoot: args.projectRoot });
const store = new KanbanStore(args.db ?? storage.kanbanDbPath);
const realtime = new RealtimeHub();
setPlannerRealtimeHub(realtime);
const orchestrator = new Orchestrator(
  store,
  logger,
  args.workflow ?? storage.workflowPath,
  realtime,
);

if (store.listCards().length === 0) {
  store.createCard({
    title: "Wire the Kanban board to Symphony",
    description:
      "Use this card to verify the local board, scheduler, workspace creation, and Codex dispatch loop.",
    priority: 2,
    state: "Review",
    labels: ["bootstrap"],
  });
}

await orchestrator.start();
serveBoard(store, orchestrator, logger, args.port, realtime);

process.on("SIGINT", () => {
  logger.info("shutdown_requested", { signal: "SIGINT" });
  orchestrator.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("shutdown_requested", { signal: "SIGTERM" });
  orchestrator.stop();
  process.exit(0);
});

function parseArgs(argv: string[]) {
  const options = {
    port: Number(process.env.PORT ?? 3000),
    db: process.env.KANBAN_DB,
    workflow: process.env.WORKFLOW,
    projectRoot:
      process.env.T3CODE_ORCHESTRATION_PROJECT_ROOT ?? process.env.T3CODE_PROJECT_ROOT ?? undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--db") options.db = argv[++index]!;
    else if (arg === "--workflow") options.workflow = argv[++index]!;
    else if (arg === "--project-root") options.projectRoot = argv[++index]!;
  }
  return options;
}
