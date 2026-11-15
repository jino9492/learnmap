import { spawn } from "node:child_process";

const processes = [
  spawn(
    process.execPath,
    ["--env-file-if-exists=.env", "apps/api/src/demo-server.mjs"],
    { stdio: "inherit", windowsHide: true },
  ),
  spawn(
    process.execPath,
    [
      "--env-file-if-exists=.env",
      "node_modules/vite/bin/vite.js",
      "--config",
      "apps/web/vite.config.ts",
    ],
    { stdio: "inherit", windowsHide: true },
  ),
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill();
};
for (const child of processes) {
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    stop();
  });
  child.on("exit", (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
