/** Ids for nodes, wires and switch rules. Its own module so the node catalogue
    and the graph helpers can share it without importing each other. */
export const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
