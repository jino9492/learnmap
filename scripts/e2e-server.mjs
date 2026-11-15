import { readFile } from "node:fs/promises";
import { createDemoServer } from "../apps/api/src/demo-server.mjs";

// An in-memory fixture server keeps browser tests independent of real AI and user data.
const fixture = JSON.parse(
  await readFile(new URL("../examples/fixture.json", import.meta.url), "utf8"),
);
const server = createDemoServer({
  env: {},
  clientFactory: () => ({
    async generate(request) {
      let value = structuredClone(fixture[request.name]);
      if (request.name === "concept_extraction")
        value.concepts = value.concepts.map((concept) => {
          const source = request.data.sources.find(
            (source) => source.location === concept.sourceLocation,
          );
          const excerpt = source?.excerpts.find((excerpt) =>
            excerpt.text.includes(concept.evidence),
          );
          return { ...concept, evidence: excerpt?.id };
        });
      if (request.name === "question_generation") {
        value.type = request.data.type;
        value.options =
          value.type === "MULTIPLE_CHOICE"
            ? [
                value.referenceAnswer,
                "모든 페이지가 메모리에 있는 경우입니다.",
                "프로세스가 정상 종료한 경우입니다.",
                "파일 이름을 변경한 경우입니다.",
              ]
            : [];
      }
      if (request.name === "choice_question_review")
        value = {
          acceptableOptions: [request.data.question.options[0]],
          explanation: "정답이 하나입니다.",
        };
      if (request.name === "path_recommendation")
        value.steps = request.data.graph.concepts.map((concept) => ({
          conceptId: concept.id,
          reason: "선수 개념부터 차례로 복습합니다.",
        }));
      return request.schema.parse(value);
    },
  }),
});
server.listen(8791, "127.0.0.1");
