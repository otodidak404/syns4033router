// Caveman injector: appends a caveman-style instruction into the system message
// of the final request body, just before it is dispatched to the provider executor.
// Shape handling lives in systemPrompt.js (shared with modelSkill.js).

import { CAVEMAN_PROMPTS } from "./cavemanPrompts.js";
import { injectSystemText } from "./systemPrompt.js";

export function injectCaveman(body, format, level) {
  const prompt = CAVEMAN_PROMPTS[level];
  if (!body || !prompt) return false;
  return injectSystemText(body, format, prompt);
}