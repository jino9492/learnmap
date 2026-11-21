import { createAiLoading } from "../../../demo/loading.js";
import { z } from "zod";

const citation = z.object({ sourceLocation: z.string(), evidence: z.string() });
const detail = citation.extend({ name: z.string(), description: z.string() });
const concept = detail.extend({
  id: z.string(),
  details: z.array(detail).optional(),
  detailsState: z.enum(["pending", "ready"]).optional(),
  citations: z.array(citation).optional(),
});
const relation = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(["PARENT_CHILD", "PREREQUISITE", "RELATED"]),
  reason: z.string(),
});
export const statusSchema = z.enum([
  "NOT_STARTED",
  "MASTERED",
  "REVIEW_REQUIRED",
  "WEAK",
]);
const progress = z.object({
  conceptId: z.string(),
  score: z.number(),
  status: statusSchema,
  accuracy: z.number().optional(),
  total: z.number().optional(),
  answered: z.number().optional(),
});
const recommendation = z.object({
  steps: z.array(z.object({ conceptId: z.string(), reason: z.string() })),
  possibleCause: z.string(),
});
export const materialSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  error: z.unknown().optional(),
  warnings: z.array(z.string()).optional(),
  analysisProgress: z
    .object({
      stage: z.string(),
      label: z.string(),
      percent: z.number().min(0).max(100),
      waiting: z.boolean().optional(),
      completed: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
});
export const workspaceSchema = z.object({
  subjects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      conceptCount: z.number(),
      materialCount: z.number(),
    }),
  ),
});
export const subjectSchema = z.object({
  queueState: z.object({ waiting: z.number(), active: z.number() }).optional(),
  id: z.string(),
  name: z.string(),
  graph: z.object({
    concepts: z.array(concept),
    relations: z.array(relation),
    coreGroups: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          memberIds: z.array(z.string()),
        }),
      )
      .optional(),
    equivalences: z
      .array(z.object({ memberIds: z.array(z.string()), reason: z.string() }))
      .optional(),
  }),
  materials: z.array(materialSchema),
  progress: z.array(progress),
  path: recommendation.nullable(),
  history: z.array(
    z.object({
      conceptName: z.string(),
      question: z.string(),
      answer: z.string(),
      createdAt: z.string(),
      status: z.string(),
      score: z.number().optional(),
      feedback: z.string().nullable().optional(),
    }),
  ),
});
const localization = z.object({ warning: z.string().optional() }).optional();
const publicQuestion = z.object({
  questionId: z.string(),
  topic: z.string(),
  question: z.object({
    type: z.enum(["ESSAY", "SHORT_ANSWER", "MULTIPLE_CHOICE"]),
    question: z.string(),
    options: z.array(z.string()),
  }),
  localization,
});
export const questionSetSchema = z.object({
  setId: z.string(),
  total: z.number(),
  questions: z.array(publicQuestion),
});
export const evaluationSchema = z.object({
  evaluation: z.object({
    score: z.number(),
    feedback: z.string(),
    weakPoints: z.array(z.string()),
  }),
  progress,
  localization,
});
export const idSchema = z.object({ id: z.string() });
export const pathSchema = z.object({ path: recommendation, localization });
export const detailsSchema = z.object({ concept, localization });
export type Subject = z.infer<typeof subjectSchema>;
export type Concept = z.infer<typeof concept>;
export type Citation = z.infer<typeof citation>;
export type Material = z.infer<typeof materialSchema>;
export type Status = z.infer<typeof statusSchema>;
export type QuestionSet = z.infer<typeof questionSetSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "요청을 완료하지 못했습니다.";

export const request = async <T>(
  url: string,
  schema: z.ZodType<T>,
  options?: RequestInit,
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ApiError(
      "서버에 연결할 수 없습니다. 연결을 확인하고 다시 시도해 주세요.",
      0,
    );
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(body);
    throw new ApiError(
      parsed.success
        ? parsed.data.error.message
        : "요청을 완료하지 못했습니다.",
      response.status,
    );
  }
  return schema.parse(body);
};
const withAiLoading = createAiLoading();
export const post = <T>(
  url: string,
  schema: z.ZodType<T>,
  data: unknown,
): Promise<T> => {
  const run = (signal?: AbortSignal) =>
    request(url, schema, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const action =
    /\/api\/analyses\/[^/]+\/(details|questions|evaluations|path)$/.exec(
      url,
    )?.[1];
  return action
    ? withAiLoading(action, run, url.slice(0, url.lastIndexOf("/")) + "/queue")
    : run();
};
export const subjectKey = (id: string) => ["subject", id];
export const subjectUrl = (id: string, page = "graph") =>
  `/subjects/${encodeURIComponent(id)}/${page}`;
export const conceptUrl = (
  subjectId: string,
  conceptId: string,
  quiz = false,
) =>
  subjectUrl(
    subjectId,
    `concepts/${encodeURIComponent(conceptId)}${quiz ? "/quiz" : ""}`,
  );
