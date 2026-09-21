/** Action `document.read` on type `document` → permission `read` (ADR-0010). */
export function permissionName(action: string, resourceType: string): string {
  const prefix = resourceType + ".";
  return action.startsWith(prefix) ? action.slice(prefix.length) : action;
}

export { pruneExplanation } from "./finalize.js";
