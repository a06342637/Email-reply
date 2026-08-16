import type { Rule } from "../types";

export function writableRules(rules: Rule[]) {
  return rules.map((rule) => ({
    ...(rule.id ? { id: rule.id } : {}),
    name: rule.name,
    enabled: rule.enabled,
    templateId: rule.templateId,
    conditions: rule.conditions,
  }));
}
