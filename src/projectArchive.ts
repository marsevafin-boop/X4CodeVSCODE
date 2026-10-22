import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ProjectArchive {
  path: string;
  archivedAt: number;
}

export interface ProjectMovePlan {
  originalPath: string;
  archivePath: string;
  source: string;
  destination: string;
  restoring: boolean;
}

/** Archive metadata cannot authorize moving an unrelated directory on restore. */
export function normalizeProjectArchive(originalPath: string, value: unknown): ProjectArchive | undefined {
  if (!value || typeof value !== "object" || !path.isAbsolute(originalPath)) return undefined;
  const candidate = value as Partial<ProjectArchive>;
  if (typeof candidate.path !== "string" || !path.isAbsolute(candidate.path) ||
      typeof candidate.archivedAt !== "number" || !Number.isFinite(candidate.archivedAt) || candidate.archivedAt < 0) return undefined;
  const original = path.resolve(originalPath);
  const archive = path.resolve(candidate.path);
  const container = path.join(path.dirname(original), "Archive");
  if (original === path.parse(original).root || original === container ||
      path.dirname(archive) !== container || archive === original) return undefined;
  return { path: archive, archivedAt: candidate.archivedAt };
}

export function directoriesOverlap(first: string, second: string): boolean {
  const a = path.resolve(first);
  const b = path.resolve(second);
  const relative = path.relative(a, b);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) ||
    (() => { const reverse = path.relative(b, a); return !reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse); })();
}

export async function pathEntryExists(value: string): Promise<boolean> {
  try { await fs.lstat(value); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function requireDirectory(value: string, label: string) {
  const entry = await fs.lstat(value);
  if (entry.isSymbolicLink()) throw new Error(`${label} — символическая ссылка. Переместите обычную папку проекта.`);
  if (!entry.isDirectory()) throw new Error(`${label} не является папкой.`);
}

/** Planning is read-only: no container or folder is created before confirmation. */
export async function planProjectMove(originalPath: string, archive?: ProjectArchive): Promise<ProjectMovePlan> {
  if (!path.isAbsolute(originalPath)) throw new Error("Для архива нужен абсолютный путь проекта.");
  const original = path.resolve(originalPath);
  const container = path.join(path.dirname(original), "Archive");
  if (original === path.parse(original).root || original === container) throw new Error("Нельзя архивировать корень диска или саму папку Archive.");
  if (await pathEntryExists(container)) await requireDirectory(container, "Папка Archive");
  let archivePath: string;
  if (archive) {
    const validated = normalizeProjectArchive(original, archive);
    if (!validated) throw new Error("Адрес архива некорректен: ожидается папка внутри соседней Archive.");
    archivePath = validated.path;
  } else {
    const base = path.basename(original);
    archivePath = path.join(container, base);
    let suffix = 2;
    while (await pathEntryExists(archivePath)) archivePath = path.join(container, `${base} (${suffix++})`);
  }
  const source = archive ? archivePath : original;
  const destination = archive ? original : archivePath;
  await requireDirectory(source, "Папка проекта");
  if (await pathEntryExists(destination)) throw new Error(`Путь восстановления уже занят: ${destination}. Освободите его перед восстановлением.`);
  return { originalPath: original, archivePath, source, destination, restoring: !!archive };
}

export interface ProjectMoveOperations {
  rename: (source: string, destination: string) => Promise<void>;
  persist: () => Promise<void>;
}

/** Only rename is used. A failed settings write rolls the same directory back. */
export async function executeProjectMove(plan: ProjectMovePlan, operations: ProjectMoveOperations): Promise<void> {
  // Revalidate immediately before rename, including dangling destination symlinks.
  const checked = await planProjectMove(plan.originalPath, plan.restoring ? { path: plan.archivePath, archivedAt: 0 } : undefined);
  if (checked.source !== plan.source || checked.destination !== plan.destination) throw new Error("Адрес архива изменился. Повторите операцию.");
  const container = path.dirname(plan.archivePath);
  if (!plan.restoring) {
    await fs.mkdir(container, { recursive: true });
    await requireDirectory(container, "Папка Archive");
  }
  await operations.rename(plan.source, plan.destination);
  try {
    await operations.persist();
  } catch (error) {
    try {
      if (await pathEntryExists(plan.source)) throw new Error("Исходный путь уже занят");
      await operations.rename(plan.destination, plan.source);
    } catch (rollbackError) {
      throw new Error(`Не удалось сохранить настройки и вернуть папку. Файлы сохранены по адресу ${plan.destination}; исходный адрес: ${plan.source}. Восстановите расположение вручную. Ошибка: ${String(rollbackError)}. Причина: ${String(error)}`);
    }
    throw error;
  }
}
