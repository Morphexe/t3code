type DevProcess = {
  name: string;
  process: Bun.Subprocess<"inherit", "inherit", "inherit">;
};

const apiPort = process.env.API_PORT ?? process.env.PORT ?? "3001";
const uiPort = process.env.UI_PORT ?? process.env.VITE_DEV_PORT ?? "5173";
const apiTarget = `http://localhost:${apiPort}`;
const embeddedInT3 = process.env.T3CODE_ORCHESTRATOR_EMBEDDED === "1";

function start(name: string, command: string[], env: Record<string, string> = {}) {
  console.log(`[dev] starting ${name}: ${command.join(" ")}`);
  return {
    name,
    process: Bun.spawn(command, {
      env: { ...process.env, ...env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  };
}

const processes: DevProcess[] = [
  start("api", ["bun", "--watch", "src/index.ts", "--port", apiPort]),
];

if (!embeddedInT3) {
  processes.push(
    start("ui", ["bun", "x", "vite", "--host", "0.0.0.0", "--port", uiPort], {
      VITE_API_TARGET: apiTarget,
      VITE_DEV_PORT: uiPort,
    }),
  );
}

if (!embeddedInT3) {
  console.log(`[dev] UI with HMR: http://localhost:${uiPort}`);
}
console.log(`[dev] API server:    ${apiTarget}`);
if (embeddedInT3) {
  console.log("[dev] T3 embedded UI: use the /orchestration route in the T3 web app");
}

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] stopping dev servers (${signal})`);
  for (const child of processes) child.process.kill();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const exited = await Promise.race(
  processes.map(async (child) => ({
    name: child.name,
    code: await child.process.exited,
  })),
);

if (!shuttingDown) {
  console.error(`[dev] ${exited.name} exited with code ${exited.code}`);
  for (const child of processes) child.process.kill();
  process.exit(exited.code ?? 1);
}
