import { z } from "zod";
import data from "./questions.v2.json";

export const questionIdSchema = z.string().regex(/^Q(0[1-9]|1[0-9]|20)$/);
export type QuestionId = `Q${string}`;
export type Option = "A" | "B";
const questionSchema = z.strictObject({
  id: questionIdSchema, category: z.string().min(1),
  options: z.strictObject({ A: z.string().min(1), B: z.string().min(1) }),
  followUp: z.string().min(1),
});
const catalog = z.strictObject({ contentVersion: z.literal("2026-09-22.1"),
  questions: z.array(questionSchema).length(20), }).parse(data);
export const CONTENT_VERSION = catalog.contentVersion;
export const questions = catalog.questions;
export const questionIds = questions.map((q) => q.id);
export function getQuestion(id: string) {
  const question = questions.find((q) => q.id === id);
  if (!question) throw new Error("Unknown question identifier");
  return question;
}
