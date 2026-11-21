import { createDemoServer } from "../apps/api/src/demo-server.mjs";
const port = Number(process.env.PARALLEL_DEMO_PORT || 8792);
const server = createDemoServer({ parallelDemo: true });
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `LearnMap 병렬 분석 · 실제 AI API · http://127.0.0.1:${port}/parallel`,
  ),
);
