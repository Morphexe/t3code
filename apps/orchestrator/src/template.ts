export class TemplateError extends Error {
  constructor(
    message: string,
    public readonly code: "template_parse_error" | "template_render_error",
  ) {
    super(message);
  }
}

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  const source = template.trim() || "You are working on an issue from the Kanban board.";
  return source.replace(/{{\s*([^{}]+)\s*}}/g, (_match, expression: string) => {
    const value = resolveExpression(expression.trim(), context);
    if (Array.isArray(value)) return value.join(", ");
    if (value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function resolveExpression(expression: string, context: Record<string, unknown>): unknown {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(expression)) {
    throw new TemplateError(
      `Unsupported template expression "${expression}"`,
      "template_parse_error",
    );
  }

  let cursor: unknown = context;
  for (const part of expression.split(".")) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) {
      throw new TemplateError(`Unknown template variable "${expression}"`, "template_render_error");
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
