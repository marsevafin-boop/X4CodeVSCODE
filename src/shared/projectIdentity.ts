import type { ProjectInfo } from "./protocol";

/** Prefix keeps profile keys distinct from absolute legacy folder keys. */
export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && /^project-[a-z0-9][a-z0-9_-]{0,119}$/i.test(value);
}

export function projectKey(project: Pick<ProjectInfo, "id" | "path">): string {
  return isProjectId(project.id) ? project.id : project.path;
}
