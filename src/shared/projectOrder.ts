/** Retain saved positions for known projects and append newly discovered keys. */
export function reconcileProjectOrder(knownKeys: readonly string[], savedKeys: readonly string[]): string[] {
  const remaining = new Set(knownKeys);
  const order: string[] = [];
  for (const key of savedKeys) {
    if (remaining.delete(key)) order.push(key);
  }
  return [...order, ...remaining];
}

/** Move between visible projects without moving archived projects' positions. */
export function moveInProjectOrder(
  fullOrder: readonly string[],
  activeKeys: readonly string[],
  key: string,
  direction: "up" | "down",
): string[] {
  const order = [...fullOrder];
  const active = new Set(activeKeys);
  const index = order.indexOf(key);
  if (index < 0 || !active.has(key) || (direction !== "up" && direction !== "down")) return order;
  const step = direction === "up" ? -1 : 1;
  for (let adjacent = index + step; adjacent >= 0 && adjacent < order.length; adjacent += step) {
    if (!active.has(order[adjacent])) continue;
    [order[index], order[adjacent]] = [order[adjacent], order[index]];
    break;
  }
  return order;
}

/** Accept only a complete visible permutation, retaining hidden project slots. */
export function applyActiveProjectOrder(
  fullOrder: readonly string[],
  activeKeys: readonly string[],
  requestedKeys: readonly string[],
): string[] | null {
  const active = new Set(activeKeys);
  if (!Array.isArray(requestedKeys) || requestedKeys.length !== active.size) return null;
  const requested = new Set(requestedKeys);
  if (requested.size !== active.size || requestedKeys.some((key) => !active.has(key))) return null;
  const order = reconcileProjectOrder([...fullOrder, ...active], fullOrder);
  let index = 0;
  return order.map((key) => active.has(key) ? requestedKeys[index++] : key);
}
