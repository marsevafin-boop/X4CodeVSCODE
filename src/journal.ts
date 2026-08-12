import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Журнал сессий — общая память между агентами и устройствами (раздел 8.4).
 * Источник правды — файлы в репозитории, а не история чатов.
 */

const MAX_CHARS_PER_ENTRY = 2500;

/**
 * Собирает контекст из последних записей журнала для первого промпта
 * новой сессии. Возвращает null, если журнала нет.
 */
export async function readJournalContext(
  cwd: string,
  dir: string,
  maxEntries: number,
): Promise<string | null> {
  const journalPath = path.join(cwd, dir);
  let files: string[];
  try {
    files = await fs.readdir(journalPath);
  } catch {
    return null; // журнала ещё нет — это нормально
  }

  // Имена вида YYYY-MM-DD-HHmm.md сортируются лексикографически == хронологически.
  const recent = files
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, maxEntries);
  if (recent.length === 0) return null;

  const parts: string[] = [];
  for (const f of recent) {
    try {
      const text = await fs.readFile(path.join(journalPath, f), "utf8");
      const clipped =
        text.length > MAX_CHARS_PER_ENTRY ? text.slice(0, MAX_CHARS_PER_ENTRY) + "\n…" : text;
      parts.push(`--- ${f} ---\n${clipped.trim()}`);
    } catch {
      // повреждённый файл пропускаем
    }
  }
  if (parts.length === 0) return null;

  return (
    `Контекст прошлых рабочих сессий из журнала «${dir}» (свежие записи первыми):\n\n` +
    parts.join("\n\n") +
    `\n\nУчитывай этот контекст в работе, но не пересказывай его пользователю.`
  );
}

/** Служебный промпт «запиши итоги сессии в журнал и закоммить». */
export function buildFinishPrompt(dir: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  return (
    `Заверши рабочую сессию. Создай файл ${dir}/${stamp}.md с кратким резюме ` +
    `этой сессии по пунктам: что сделано; какие решения приняты и почему; ` +
    `что осталось и следующие шаги. Пиши сжато. Если директории ${dir} нет — создай. ` +
    `Если проект под git — выполни git add этого файла и git commit -m "journal: итоги сессии". ` +
    `Больше никаких изменений не делай.`
  );
}
