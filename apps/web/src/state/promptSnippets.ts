import { createPromptSnippetsEnvironmentAtoms } from "@t3tools/client-runtime/state/promptSnippets";
import { connectionAtomRuntime } from "../connection/runtime";

export const promptSnippetsEnvironment =
  createPromptSnippetsEnvironmentAtoms(connectionAtomRuntime);
