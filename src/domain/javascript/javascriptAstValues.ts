import * as t from "@babel/types";
import type { JavaScriptSemanticPrimitive } from "./javascriptSemanticValueTypes.js";
import { SEMANTIC_EXPRESSION_DEPTH_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  childNodes,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

/** TypeScript receiver annotations occupy no positional runtime parameter slot. */
export const runtimeFunctionParameters = (
  node: t.Function,
): t.Function["params"] =>
  t.isIdentifier(node.params[0], { name: "this" })
    ? node.params.slice(1)
    : node.params;

/**
 * Remove wrappers that affect TypeScript or Flow checking but not runtime
 * expression identity. The returned depth lets bounded evaluators account for
 * syntax that normalization would otherwise skip.
 */
export const unwrapJavaScriptExpression = (
  node: t.Node,
  options?: { readonly stopAtParentheses: boolean },
): { readonly node: t.Node; readonly depth: number } => {
  let current = node;
  let depth = 0;
  while (
    t.isParenthesizedExpression(current) ||
    t.isTSAsExpression(current) ||
    t.isTSTypeAssertion(current) ||
    t.isTSNonNullExpression(current) ||
    t.isTSSatisfiesExpression(current) ||
    t.isTSInstantiationExpression(current) ||
    t.isTypeCastExpression(current)
  ) {
    // Optional-chain grouping affects execution even when expression identity
    // is transparent. Keep every grouping boundary available to that consumer.
    if (
      options?.stopAtParentheses === true &&
      (t.isParenthesizedExpression(current) ||
        current.extra?.parenthesized === true)
    )
      break;
    current = current.expression;
    depth += 1;
  }
  return { node: current, depth };
};

/** Follow a returned value without changing call-reference or side-effect rules. */
export const javaScriptExpressionValue = (node: t.Node): t.Node => {
  for (;;) {
    node = unwrapJavaScriptExpression(node).node;
    if (t.isSequenceExpression(node) && node.expressions.length > 0)
      node = node.expressions.at(-1)!;
    else if (t.isAssignmentExpression(node, { operator: "=" }))
      node = node.right;
    else return node;
  }
};

/** Prove scalar results without invoking an unknown operand's coercion hooks. */
export const isPrimitiveJavaScriptExpression = (node: t.Node): boolean => {
  const pending = [{ node, depth: 0 }];
  while (pending.length > 0) {
    const item = pending.pop()!;
    const value = unwrapJavaScriptExpression(item.node);
    const depth = item.depth + value.depth + 1;
    if (depth > SEMANTIC_EXPRESSION_DEPTH_LIMIT) return false;
    node = value.node;
    if (readExactJavaScriptLiteral(node).found || t.isBigIntLiteral(node))
      continue;
    let operands: readonly t.Node[];
    if (
      t.isBinaryExpression(node) &&
      !["in", "instanceof"].includes(node.operator)
    ) {
      if (node.operator === "===" || node.operator === "!==") continue;
      operands = [node.left, node.right];
    } else if (t.isUnaryExpression(node)) {
      if (["void", "typeof", "!", "delete"].includes(node.operator)) continue;
      operands = [node.argument];
    } else if (t.isTemplateLiteral(node)) operands = node.expressions;
    else if (t.isSequenceExpression(node)) operands = node.expressions;
    else if (t.isAssignmentExpression(node, { operator: "=" }))
      operands = [node.right];
    else return false;
    for (const operand of operands) pending.push({ node: operand, depth });
  }
  return true;
};

/** Effectful inputs still evaluated when an expression returns a scalar. */
export const javaScriptScalarEvaluationSources = (
  expression: t.Node,
): readonly t.Node[] => {
  const sources: t.Node[] = [];
  const ownedChildren = new WeakSet<t.Node>();
  traverseJavaScriptAst(expression, {
    skip: (node) =>
      (t.isFunction(node) && !t.isObjectMethod(node)) ||
      ownedChildren.has(node),
    enter: (node) => {
      if (node === expression) return;
      if (t.isObjectMethod(node) || t.isObjectProperty(node)) {
        if (node.computed) sources.push(node.key);
        if (t.isObjectMethod(node))
          for (const child of childNodes(node)) ownedChildren.add(child);
      }
      if (
        t.isCallExpression(node) ||
        t.isOptionalCallExpression(node) ||
        t.isNewExpression(node) ||
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node) ||
        t.isAwaitExpression(node) ||
        t.isYieldExpression(node) ||
        t.isClass(node) ||
        t.isTaggedTemplateExpression(node) ||
        t.isSpreadElement(node) ||
        ((t.isBinaryExpression(node) ||
          t.isUnaryExpression(node) ||
          t.isTemplateLiteral(node)) &&
          !isPrimitiveJavaScriptExpression(node))
      ) {
        sources.push(node);
        // The consumer follows each selected source's evaluated inputs.
        for (const child of childNodes(node)) ownedChildren.add(child);
      }
    },
  });
  return sources;
};

/** Intrinsic scalar slots on a newly created callable, before external writes. */
export const isPrimitiveJavaScriptCallableProperty = (
  node: t.Node,
  path: readonly unknown[],
): boolean => {
  if (!t.isFunction(node) && !t.isClass(node)) return false;
  if (
    !(
      (path.length === 1 && (path[0] === "name" || path[0] === "length")) ||
      (path.length === 2 && path[0] === "name" && path[1] === "length")
    )
  )
    return false;
  if (
    t.isClass(node) &&
    ((node.decorators?.length ?? 0) > 0 ||
      node.body.body.some((member) => {
        if (
          t.isStaticBlock(member) ||
          ("decorators" in member && (member.decorators?.length ?? 0) > 0)
        )
          return true;
        if (!("static" in member) || !member.static) return false;
        if (!t.isClassMethod(member) && !t.isClassProperty(member)) return true;
        const key = semanticStaticPropertyKey(member.key, member.computed);
        if (key === null || key === path[0]) return true;
        // Unrelated method bodies are not executed at class definition. Only
        // inert field initializers can prove they leave the metadata intact.
        return (
          t.isClassProperty(member) &&
          member.value != null &&
          !readExactJavaScriptLiteral(member.value).found &&
          !t.isFunction(member.value)
        );
      }))
  )
    // Static definitions/initializers or decorators can replace the own slots.
    return false;
  return true;
};

/** Read one syntax-level primitive only when its value is exact. */
export const readExactJavaScriptLiteral = (
  node: t.Node,
):
  | { readonly found: true; readonly value: JavaScriptSemanticPrimitive }
  | { readonly found: false } => {
  node = unwrapJavaScriptExpression(node).node;
  if (t.isStringLiteral(node)) return { found: true, value: node.value };
  if (t.isNumericLiteral(node) && Number.isFinite(node.value))
    return { found: true, value: node.value };
  if (t.isBooleanLiteral(node)) return { found: true, value: node.value };
  if (t.isNullLiteral(node)) return { found: true, value: null };
  if (
    t.isTemplateLiteral(node) &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    const cooked = node.quasis[0]?.value.cooked;
    return cooked === null || cooked === undefined
      ? { found: false }
      : { found: true, value: cooked };
  }
  return { found: false };
};

/** Read an identifier or literal property name without evaluating syntax. */
export const propertyName = (node: t.Node): string => {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node))
    return String(node.value);
  return "";
};

/** Read a property name only when its syntax commits to one exact key. */
export const semanticStaticPropertyName = (
  property: t.Node,
  computed: boolean,
): string => semanticStaticPropertyKey(property, computed) ?? "";

/** Read an exact property key, preserving the legal empty-string key. */
export const semanticStaticPropertyKey = (
  property: t.Node,
  computed: boolean,
): string | null => {
  property = unwrapJavaScriptExpression(property).node;
  if (
    t.isStringLiteral(property) ||
    t.isNumericLiteral(property) ||
    t.isBooleanLiteral(property)
  )
    return String(property.value);
  if (t.isNullLiteral(property)) return "null";
  if (t.isBigIntLiteral(property)) return String(property.value);
  if (t.isUnaryExpression(property, { operator: "void" })) return "undefined";
  if (t.isUnaryExpression(property, { operator: "+" })) {
    const argument = unwrapJavaScriptExpression(property.argument).node;
    if (t.isNumericLiteral(argument)) return String(argument.value);
  }
  if (t.isUnaryExpression(property, { operator: "-" })) {
    const argument = unwrapJavaScriptExpression(property.argument).node;
    if (t.isNumericLiteral(argument)) return String(-argument.value);
    if (t.isBigIntLiteral(argument)) return String(-BigInt(argument.value));
  }
  if (
    t.isTemplateLiteral(property) &&
    property.expressions.length === 0 &&
    property.quasis.length === 1
  ) {
    const cooked = property.quasis[0]?.value.cooked;
    return cooked === null || cooked === undefined ? null : cooked;
  }
  return !computed && t.isIdentifier(property) ? property.name : null;
};

/** Syntax whose value cannot contribute own properties to an object spread. */
export const isNullishJavaScriptSyntax = (node: t.Node): boolean => {
  node = unwrapJavaScriptExpression(node).node;
  return (
    t.isNullLiteral(node) || t.isUnaryExpression(node, { operator: "void" })
  );
};

type StaticObjectProperty =
  | { readonly status: "missing" | "dynamic" }
  | { readonly status: "explicit"; readonly property: t.ObjectProperty };

/** Find the effective explicit property, preserving unresolved overrides. */
export const staticObjectProperty = (
  object: t.Node | undefined,
  name: string,
  isNullish?: (node: t.Node) => boolean,
): StaticObjectProperty => {
  if (object === undefined) return { status: "missing" };
  if (!t.isObjectExpression(object)) return { status: "dynamic" };
  const lookup = (
    current: t.ObjectExpression,
    depth: number,
  ): StaticObjectProperty => {
    for (const property of current.properties.toReversed()) {
      if (t.isSpreadElement(property)) {
        const { node: spread, depth: wrappers } = unwrapJavaScriptExpression(
          property.argument,
        );
        if (t.isObjectExpression(spread)) {
          const nextDepth = depth + wrappers + 1;
          // Copying a getter can run code that changes another source key.
          if (
            nextDepth > SEMANTIC_EXPRESSION_DEPTH_LIMIT ||
            spread.properties.some((entry) =>
              t.isObjectMethod(entry, { kind: "get" }),
            )
          )
            return { status: "dynamic" };
          const found = lookup(spread, nextDepth);
          if (found.status === "missing") continue;
          return found;
        }
        // These primitive boxes have no own keys; strings can own index keys.
        if (
          t.isBooleanLiteral(spread) ||
          t.isNumericLiteral(spread) ||
          t.isBigIntLiteral(spread) ||
          isNullish?.(property.argument) === true
        )
          continue;
        return { status: "dynamic" };
      }
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (key === null) return { status: "dynamic" };
      if (key !== name) continue;
      return t.isObjectProperty(property)
        ? { status: "explicit", property }
        : { status: "dynamic" };
    }
    return { status: "missing" };
  };
  return lookup(object, 0);
};

/** Later properties own a key; an intervening dynamic write leaves it unknown. */
export const semanticFinalObjectProperty = (
  node: t.ObjectExpression,
  key: string,
): t.Node | undefined => {
  const property = staticObjectProperty(node, key);
  return property.status === "explicit" ? property.property.value : undefined;
};

export const semanticFinalObjectStringProperty = (
  node: t.ObjectExpression,
  key: string,
): string | undefined => {
  const value = semanticFinalObjectProperty(node, key);
  return t.isStringLiteral(value) ? value.value : undefined;
};

/** Read exact consumed object-pattern keys, leaving dynamic keys unknown. */
export const semanticObjectPatternKeys = (
  pattern: t.ObjectPattern,
): readonly string[] =>
  pattern.properties.flatMap((property) => {
    if (t.isRestElement(property)) return [];
    const key = semanticStaticPropertyKey(property.key, property.computed);
    return key === null ? [] : [key];
  });

/** Return the syntactic node whose target this construct writes. */
export const semanticWriteSiteTarget = (node: t.Node): t.Node | null => {
  if (t.isAssignmentExpression(node)) return node.left;
  if (t.isUpdateExpression(node)) return node.argument;
  if (t.isUnaryExpression(node, { operator: "delete" })) return node.argument;
  if (t.isForOfStatement(node) || t.isForInStatement(node)) return node.left;
  return null;
};

/** Whether a write site reads the previous target value before writing. */
export const semanticWriteSiteReadsFirst = (site: t.Node): boolean =>
  (t.isAssignmentExpression(site) && site.operator !== "=") ||
  t.isUpdateExpression(site);

/** Find the owning write site through inert TypeScript and parenthesis wrappers. */
export const semanticWrappedWriteSite = (
  node: t.Node,
  parent: t.Node,
  ancestors: readonly t.Node[],
): t.Node | null => {
  const chain =
    ancestors.at(-1) === parent ? ancestors : [...ancestors, parent];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (candidate === undefined) return null;
    const target = semanticWriteSiteTarget(candidate);
    if (target !== null)
      return unwrapJavaScriptExpression(target).node === node
        ? candidate
        : null;
    if (unwrapJavaScriptExpression(candidate).depth === 0) return null;
  }
  return null;
};

/** Visit binding and member leaves in direct and destructuring write targets. */
export function* semanticWriteTargets(
  root: t.Node,
): Generator<t.Identifier | t.MemberExpression | t.OptionalMemberExpression> {
  const pending = [root];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const node = unwrapJavaScriptExpression(next).node;
    if (
      t.isIdentifier(node) ||
      t.isMemberExpression(node) ||
      t.isOptionalMemberExpression(node)
    )
      yield node;
    else if (t.isRestElement(node)) pending.push(node.argument);
    else if (t.isAssignmentPattern(node)) pending.push(node.left);
    else if (t.isArrayPattern(node)) {
      for (const element of node.elements.toReversed())
        if (element !== null) pending.push(element);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties.toReversed())
        pending.push(
          t.isRestElement(property) ? property.argument : property.value,
        );
    }
  }
}

/**
 * Display an exact JavaScript string as nonempty label text. Graph labels and
 * artifact-local keys are nonempty, so the legal empty value is shown as `""`;
 * producers keep the exact value in their properties.
 */
export const javascriptDisplayText = (value: string): string =>
  value === "" ? '""' : value;
