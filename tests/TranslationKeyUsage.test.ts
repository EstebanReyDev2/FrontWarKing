import fs from "fs";
import path from "path";
import ts from "typescript";

const PROJECT_ROOT = path.join(__dirname, "..");
const SOURCE_DIR = path.join(PROJECT_ROOT, "src");
const EN_JSON = path.join(PROJECT_ROOT, "resources", "lang", "en.json");

/**
 * Keys that were already missing before the clan-UI cleanup. They are kept
 * here so this test can enforce that no NEW static key is missing without
 * hiding an unrelated, pre-existing gap. Remove an entry when its key is
 * added to en.json.
 */
const PREEXISTING_MISSING_KEYS = new Set([
  "cooldown",
  "steam_link_modal.reason_rate_limited",
  "steam_link_modal.reason_steam_has_progress",
]);

function getAllSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllSourceFiles(fullPath));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(fullPath);
    }
  }
  return files;
}

function hasTranslationKey(
  translations: Record<string, unknown>,
  key: string,
): boolean {
  let current: unknown = translations;
  for (const part of key.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, part)
    ) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

function staticText(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticText(expression.left);
    const right = staticText(expression.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function isTranslateTextCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === "translateText";
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name.text === "translateText";
  }
  return false;
}

const KEY_LIKE_PROPERTY_NAMES = new Set([
  "labelKey",
  "translationKey",
  "defaultLabelKey",
  "disabledKey",
  "titleKey",
  "ariaLabelKey",
  "placeholderKey",
]);

function isKeyLikePropertyName(name: ts.PropertyName): boolean {
  if (ts.isIdentifier(name)) return KEY_LIKE_PROPERTY_NAMES.has(name.text);
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return KEY_LIKE_PROPERTY_NAMES.has(name.text);
  }
  return false;
}

function collectStaticallyUsedKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const sourceFile = ts.createSourceFile(
    "source.ts",
    content,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );

  const add = (value: string | null) => {
    if (value === null || value.length === 0) return;
    // A trailing dot or an interpolation is a prefix, not a complete key.
    // Dynamic keys are deliberately outside this test's scope.
    if (value.endsWith(".") || value.includes("$")) return;
    // The key-like properties are also used for non-translation data such as
    // keyboard bindings ("ShiftLeft"). Translation keys are namespaced with a
    // dot; the bare key below is an explicit, pre-existing exception.
    if (!value.includes(".") && !PREEXISTING_MISSING_KEYS.has(value)) return;
    keys.add(value);
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isTranslateTextCall(node)) {
      const firstArg = node.arguments[0];
      if (firstArg !== undefined) add(staticText(firstArg));
    }

    if (
      ts.isPropertyAssignment(node) &&
      isKeyLikePropertyName(node.name) &&
      ts.isExpression(node.initializer)
    ) {
      add(staticText(node.initializer));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  for (const match of content.matchAll(
    /data-i18n(?:-title|-alt|-aria-label|-placeholder)?\s*=\s*["']([^"']+)["']/g,
  )) {
    add(match[1]);
  }

  for (const match of content.matchAll(
    /\b(?:translationKey|labelKey|defaultLabelKey|disabledKey|titleKey|ariaLabelKey|placeholderKey)\s*[:=]\s*["']([^"']+)["']/g,
  )) {
    add(match[1]);
  }

  return keys;
}

/**
 * This test covers static keys only: translateText("..."), key-like object
 * properties, data-i18n* attributes and translationKey-like attributes.
 * Dynamic keys (template literals, concatenations and lookup tables whose
 * values are not in a key-named property) are not verified here. The existing
 * TranslationSystem test has the same limitation for dynamic keys.
 */
describe("translation key usage", () => {
  const enJson = JSON.parse(fs.readFileSync(EN_JSON, "utf8"));
  const usedKeys = new Set<string>();

  for (const file of getAllSourceFiles(SOURCE_DIR)) {
    const content = fs.readFileSync(file, "utf8");
    for (const key of collectStaticallyUsedKeys(content)) {
      usedKeys.add(key);
    }
  }

  it("has every statically used key in en.json", () => {
    const missing = [...usedKeys]
      .filter((key) => !hasTranslationKey(enJson, key))
      .filter((key) => !PREEXISTING_MISSING_KEYS.has(key))
      .sort();

    expect(missing).toEqual([]);
  });

  it("does not keep stale entries in the pre-existing-gaps allowlist", () => {
    const stillMissing = [...PREEXISTING_MISSING_KEYS]
      .filter((key) => !hasTranslationKey(enJson, key))
      .sort();

    expect(stillMissing).toEqual([...PREEXISTING_MISSING_KEYS].sort());
  });
});
