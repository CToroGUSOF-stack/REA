import { isDeepStrictEqual } from "node:util";

import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./jsonSchemaKeywords.js";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const literalSchemaType = (value: unknown): string | undefined => {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return undefined;
};

const resolvePointer = (
  root: Readonly<Record<string, unknown>>,
  tokens: readonly string[],
): unknown => {
  let value: unknown = root;
  for (const token of tokens) {
    // A pointer can cross a resource boundary; preserve the original
    // projection rather than guess the reference scope beyond it.
    if (value !== root && declaresResource(value)) return undefined;
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      const index = Number(token);
      if (index >= value.length) return undefined;
      value = value[index];
      continue;
    }
    if (!isObject(value) || !Object.hasOwn(value, token)) return undefined;
    value = value[token];
  }
  return value;
};

const findSchemaAnchor = (
  root: Readonly<Record<string, unknown>>,
  name: string,
): readonly string[] | undefined => {
  const scan = (
    node: unknown,
    path: readonly string[],
  ): readonly string[] | undefined => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const found = scan(node[index], [...path, String(index)]);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!isObject(node)) return undefined;
    // Draft 2020-12: a plain-name fragment matches $anchor or $dynamicAnchor.
    if (node.$anchor === name || node.$dynamicAnchor === name) return path;
    for (const [key, child] of Object.entries(node)) {
      if (
        !schemaMaps.has(key) &&
        !schemaArrays.has(key) &&
        !schemaChildren.has(key)
      )
        continue;
      // Anchors inside a nested resource belong to that resource.
      if (declaresResource(child)) continue;
      if (schemaMaps.has(key) && isObject(child)) {
        for (const [childName, grandChild] of Object.entries(child)) {
          const found = scan(grandChild, [...path, key, childName]);
          if (found !== undefined) return found;
        }
      } else if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index += 1) {
          const found = scan(child[index], [...path, key, String(index)]);
          if (found !== undefined) return found;
        }
      } else {
        const found = scan(child, [...path, key]);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return scan(root, []);
};

/** Resolve a same-resource reference: `#`, pointer fragments, and anchors. */
export const resolveLocalSchemaReference = (
  root: Readonly<Record<string, unknown>>,
  reference: string,
): { readonly value: unknown; readonly tokens: readonly string[] } | undefined => {
  if (!reference.startsWith("#")) return undefined;
  // RFC 6901: percent-decode the whole fragment before splitting tokens, so
  // an encoded separator such as %2F still addresses a nested position.
  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  if (fragment === "") return { value: root, tokens: [] };
  if (!fragment.startsWith("/")) {
    // Draft 2020-12 plain-name fragments resolve to the matching $anchor.
    const anchorPath = findSchemaAnchor(root, fragment);
    if (anchorPath === undefined) return undefined;
    const value = resolvePointer(root, anchorPath);
    return value === undefined
      ? undefined
      : { value, tokens: anchorPath };
  }
  const tokens = fragment
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  const value = resolvePointer(root, tokens);
  return value === undefined ? undefined : { value, tokens };
};

const referencedDescription = (
  root: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
): string | undefined => {
  let value: unknown = schema;
  const active = new Set<string>();
  while (isObject(value)) {
    if (typeof value.description === "string") return value.description;
    if (typeof value.$ref !== "string" || active.has(value.$ref))
      return undefined;
    active.add(value.$ref);
    value = resolveLocalSchemaReference(root, value.$ref)?.value;
  }
  return undefined;
};

const describeSchema = (
  schema: unknown,
  root: Readonly<Record<string, unknown>>,
  describeProperty: (property: string) => string | undefined,
): unknown => {
  if (!isObject(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (schemaMaps.has(key) && isObject(value))
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => {
              const described = describeSchema(child, root, describeProperty);
              if (key !== "properties" || !isObject(described))
                return [name, described];
              const description =
                referencedDescription(root, described) ??
                describeProperty(name);
              return [
                name,
                description === undefined
                  ? described
                  : { ...described, description },
              ];
            }),
          ),
        ];
      if (schemaArrays.has(key) && Array.isArray(value))
        return [
          key,
          value.map((child) => describeSchema(child, root, describeProperty)),
        ];
      if (schemaChildren.has(key))
        return [
          key,
          Array.isArray(value)
            ? value.map((child) =>
                describeSchema(child, root, describeProperty),
              )
            : describeSchema(value, root, describeProperty),
        ];
      // Annotation values and literal const/enum data are not schemas.
      return [key, value];
    }),
  );
};

const objectBranch = (
  root: Readonly<Record<string, unknown>>,
  branch: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  // Reference siblings evaluate separately from the target in 2020-12, so a
  // merged object could accept inputs the branch rejects.
  const resolved =
    isObject(branch) && typeof branch.$ref === "string"
      ? Object.keys(branch).length === 1
        ? resolveLocalSchemaReference(root, branch.$ref)?.value
        : undefined
      : branch;
  return isObject(resolved) &&
    resolved.type === "object" &&
    isObject(resolved.properties)
    ? resolved
    : undefined;
};

const requiredProperties = (
  branch: Readonly<Record<string, unknown>>,
): readonly string[] =>
  Array.isArray(branch.required)
    ? branch.required.filter((name) => typeof name === "string")
    : [];

const sharedRequiredProperties = (
  branches: readonly Readonly<Record<string, unknown>>[],
): readonly string[] => {
  const [first = [], ...others] = branches.map(requiredProperties);
  return first.filter((name) => others.every((names) => names.includes(name)));
};

const inputGroup = (branch: Readonly<Record<string, unknown>>): string => {
  const required = requiredProperties(branch);
  const optional = Object.keys(branch.properties ?? {})
    .filter((name) => !required.includes(name))
    .map((name) => `[${name}]`);
  return [...required, ...optional].join(" + ");
};

type SchemaNormalization = {
  readonly schema: unknown;
  readonly changed: boolean;
};

const isBooleanLiteralSchema = (schema: unknown): boolean =>
  isObject(schema) &&
  (typeof schema.const === "boolean" ||
    (Array.isArray(schema.enum) &&
      schema.enum.length > 0 &&
      schema.enum.every((value) => typeof value === "boolean")));

const isBooleanSchema = (schema: unknown): boolean =>
  isObject(schema) &&
  (schema.type === "boolean" || isBooleanLiteralSchema(schema));

const preserveSharedDefault = (
  schema: Record<string, unknown>,
  branches: readonly unknown[],
): void => {
  if (schema.default !== undefined) return;
  const defaults = branches
    .filter(isObject)
    .map((branch) => branch.default)
    .filter((value) => value !== undefined);
  if (
    defaults.length > 0 &&
    defaults.every((value) => isDeepStrictEqual(value, defaults[0]))
  )
    schema.default = defaults[0];
};

const referencesChangingTarget = (
  node: unknown,
  root: unknown,
  active: ReadonlySet<string> = new Set(),
): boolean => {
  // A local reference hides the target's widening from the branch that uses
  // it. Treat such a sensitive branch as changed so its constraint is dropped.
  if (Array.isArray(node))
    return node.some((child) => referencesChangingTarget(child, root, active));
  if (!isObject(node)) return false;
  if (typeof node.$ref === "string" && !active.has(scopedReference(root, node.$ref))) {
    const nestedActive = new Set([...active, scopedReference(root, node.$ref)]);
    const target = resolveLocalSchemaReference(
      root as Readonly<Record<string, unknown>>,
      node.$ref,
    )?.value;
    if (target !== undefined) {
      if (
        normalizeAdvertisedSchema(target, root, nestedActive).changed
      )
        return true;
      if (referencesChangingTarget(target, root, nestedActive)) return true;
    }
    // Reference siblings evaluate alongside the target in 2020-12, so keep
    // inspecting the remaining entries below.
  }
  return Object.entries(node).some(([key, child]) => {
    if (key === "const" || key === "enum" || key === "$ref") return false;
    // References inside a nested resource address that resource only.
    if (declaresResource(child)) return false;
    return referencesChangingTarget(child, root, active);
  });
};

// Inside a nested resource, references resolve against that resource's own
// root rather than the outer schema.
const nestedResourceRoot = (child: unknown, root: unknown): unknown =>
  declaresResource(child) ? child : root;

const normalizeAdvertisedSchema = (
  value: unknown,
  root: unknown = value,
  active: ReadonlySet<string> = new Set(),
): SchemaNormalization => {
  if (!isObject(value)) return { schema: value, changed: false };

  const node: Record<string, unknown> = { ...value };
  let changed = false;
  const normalizeMap = (map: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(map).map(([name, child]) => {
        const result = normalizeAdvertisedSchema(
          child,
          nestedResourceRoot(child, root),
          active,
        );
        changed ||= result.changed;
        return [name, result.schema];
      }),
    );
  const normalizeList = (list: readonly unknown[]) =>
      list.map((child) => {
        const result = normalizeAdvertisedSchema(
          child,
          nestedResourceRoot(child, root),
          active,
        );
        changed ||= result.changed;
        return result;
      });

  for (const [key, child] of Object.entries(value)) {
    if (schemaMaps.has(key) && isObject(child)) {
      node[key] = normalizeMap(child);
    } else if (
      schemaArrays.has(key) &&
      key !== "anyOf" &&
      key !== "oneOf" &&
      Array.isArray(child)
    ) {
      node[key] = normalizeList(child).map((result) => result.schema);
    } else if (
      schemaChildren.has(key) &&
      key !== "not" &&
      key !== "if" &&
      key !== "then" &&
      key !== "else"
    ) {
      const results = Array.isArray(child)
        ? normalizeList(child)
        : [
            normalizeAdvertisedSchema(
              child,
              nestedResourceRoot(child, root),
              active,
            ),
          ];
      const nestedChanged =
        results.some((result) => result.changed) ||
        (key === "contains" &&
          referencesChangingTarget(child, root, active));
      if (
        key === "contains" &&
        nestedChanged &&
        value.maxContains !== undefined
      ) {
        delete node.contains;
        delete node.minContains;
        delete node.maxContains;
        changed = true;
      } else {
        node[key] = Array.isArray(child)
          ? results.map((result) => result.schema)
          : results[0]?.schema;
        changed ||= nestedChanged;
      }
    }
  }

  if (typeof node.const === "boolean") {
    delete node.const;
    if (node.type === undefined) node.type = "boolean";
    changed = true;
  }
  if (
    Array.isArray(node.enum) &&
    node.enum.length > 0 &&
    node.enum.every((item) => typeof item === "boolean")
  ) {
    delete node.enum;
    if (node.type === undefined) node.type = "boolean";
    changed = true;
  }
  if (node.const === "") {
    delete node.const;
    if (node.type === undefined) node.type = "string";
    changed = true;
  }
  if (Array.isArray(node.enum) && node.enum.some((item) => item === "")) {
    // An empty enum member is rejected by Gemini function declarations; widen
    // to every member type so canonical-valid values stay accepted.
    const members = node.enum;
    delete node.enum;
    if (
      node.type === undefined &&
      node.anyOf === undefined &&
      node.oneOf === undefined
    ) {
      const types = [...new Set(members.map(literalSchemaType))];
      const defined = types.filter((type): type is string => type !== undefined);
      if (defined.length === types.length) {
        if (defined.length === 1) node.type = defined[0];
        else if (defined.length > 1)
          node.anyOf = defined.map((type) => ({ type }));
      }
    }
    changed = true;
  }

  const negated = Object.hasOwn(value, "not")
    ? normalizeAdvertisedSchema(
        value.not,
        nestedResourceRoot(value.not, root),
        active,
      )
    : undefined;
  if (
    negated?.changed ||
    referencesChangingTarget(value.not, root, active)
  ) {
    // Widening a predicate under `not` narrows the containing schema.
    changed = true;
    delete node.not;
  } else if (negated !== undefined) {
    node.not = negated.schema;
  }

  const conditional = Object.hasOwn(value, "if")
    ? normalizeAdvertisedSchema(
        value.if,
        nestedResourceRoot(value.if, root),
        active,
      )
    : undefined;
  const thenBranch = Object.hasOwn(value, "then")
    ? normalizeAdvertisedSchema(
        value.then,
        nestedResourceRoot(value.then, root),
        active,
      )
    : undefined;
  const elseBranch = Object.hasOwn(value, "else")
    ? normalizeAdvertisedSchema(
        value.else,
        nestedResourceRoot(value.else, root),
        active,
      )
    : undefined;
  if (
    conditional?.changed ||
    referencesChangingTarget(value.if, root, active)
  ) {
    // Changing the predicate can route canonical-valid inputs into a rejecting branch.
    changed = true;
    delete node.if;
    delete node.then;
    delete node.else;
    // The conditional no longer evaluates its branches, so any unevaluated
    // guard would now reject inputs the branches used to cover.
    delete node.unevaluatedProperties;
    delete node.unevaluatedItems;
  } else {
    if (conditional !== undefined) node.if = conditional.schema;
    if (thenBranch !== undefined) {
      node.then = thenBranch.schema;
      changed ||= thenBranch.changed;
    }
    if (elseBranch !== undefined) {
      node.else = elseBranch.schema;
      changed ||= elseBranch.changed;
    }
  }

  for (const combinator of ["anyOf", "oneOf"] as const) {
    const branches = value[combinator];
    if (!Array.isArray(branches)) continue;
    const normalized = normalizeList(branches);
    const schemas = normalized.map((result) => result.schema);
    const branchesChanged =
      normalized.some((result) => result.changed) ||
      branches.some((branch) => referencesChangingTarget(branch, root, active));
    if (combinator === "oneOf" && branchesChanged) {
      const booleanLiteralsOnly = branches.every(isBooleanLiteralSchema);
      if (booleanLiteralsOnly) {
        node.type = "boolean";
        preserveSharedDefault(node, schemas);
        delete node.oneOf;
        changed = true;
        continue;
      }
      // `anyOf` retains branch guidance without allowing widened branches to
      // reject inputs that were accepted by exactly one canonical branch.
      delete node.oneOf;
      if (Array.isArray(node.anyOf)) {
        const existingAllOf = Array.isArray(node.allOf) ? node.allOf : [];
        node.allOf = [...existingAllOf, { anyOf: schemas }];
      } else {
        node.anyOf = schemas;
      }
      changed = true;
      continue;
    }
    if (
      branchesChanged &&
      schemas.length > 0 &&
      schemas.every(isBooleanSchema)
    ) {
      node.type = "boolean";
      preserveSharedDefault(node, schemas);
      delete node[combinator];
      changed = true;
      continue;
    }
    node[combinator] = schemas;
    changed ||= branchesChanged;
  }

  return { schema: node, changed };
};

// Anthropic tool input schemas reject anyOf, oneOf, and allOf at the root, and
// clients then drop the tool or advertise it without parameters. Present a
// root union of strict object groups as one object whose properties are the
// union of the groups. The canonical Zod schema still enforces the exact group.
const flattenRootObjectUnion = (
  root: Record<string, unknown>,
): Record<string, unknown> => {
  const { anyOf, oneOf, ...rest } = root;
  const alternatives = Array.isArray(anyOf) ? anyOf : oneOf;
  if (
    !Array.isArray(alternatives) ||
    alternatives.length === 0 ||
    root.properties !== undefined
  )
    return root;
  const branches = alternatives.map((branch) => objectBranch(root, branch));
  if (!branches.every((branch) => branch !== undefined)) return root;
  const variants = new Map<string, unknown[]>();
  for (const branch of branches)
    for (const [name, schema] of Object.entries(branch.properties ?? {})) {
      const known = variants.get(name) ?? [];
      if (!known.some((seen) => isDeepStrictEqual(seen, schema)))
        known.push(schema);
      variants.set(name, known);
    }
  const required = sharedRequiredProperties(branches);
  // A coarse property minimum rejects underspecified objects. Partner fields
  // and exact group membership remain enforced by the canonical runtime parser.
  const fewestRequired = Math.min(
    ...branches.map((branch) => requiredProperties(branch).length),
  );
  // Groups that differ only in property values add no caller guidance.
  const groups = [...new Set(branches.map(inputGroup))];
  const description = [
    typeof rest.description === "string" ? rest.description : undefined,
    groups.length > 1
      ? `Provide a complete input group: ${groups.join("; ")}.`
      : undefined,
  ].filter((text) => text !== undefined);
  const {
    dependencies: _dependencies,
    dependentRequired: _dependentRequired,
    ...presentation
  } = rest;
  return {
    ...presentation,
    type: "object",
    ...(description.length > 0 ? { description: description.join(" ") } : {}),
    properties: Object.fromEntries(
      [...variants].map(([name, schemas]) => [
        name,
        schemas.length === 1 ? schemas[0] : { anyOf: schemas },
      ]),
    ),
    ...(required.length > 0 ? { required } : {}),
    ...(fewestRequired > 0 ? { minProperties: fewestRequired } : {}),
    ...(branches.every((branch) => branch.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
};

// Resolve a trusted internal path (from our own walkers) without resource
// boundary checks: the path itself names the position, not a user reference.
const pathValue = (root: unknown, tokens: readonly string[]): unknown => {
  let value: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      const index = Number(token);
      if (index >= value.length) return undefined;
      value = value[index];
      continue;
    }
    if (!isObject(value) || !Object.hasOwn(value, token)) return undefined;
    value = value[token];
  }
  return value;
};

// Cycle guards must treat the same fragment text in different resources as
// different references, so active entries are scoped by resolution root.
let nextResourceId = 0;
const resourceIds = new WeakMap<object, number>();
const scopedReference = (root: unknown, reference: string): string => {
  if (!isObject(root)) return `x\u0000${reference}`;
  let id = resourceIds.get(root);
  if (id === undefined) {
    id = nextResourceId;
    nextResourceId += 1;
    resourceIds.set(root, id);
  }
  return `${id}\u0000${reference}`;
};

const containsResource = (
  node: unknown,
  seen: ReadonlySet<unknown> = new Set(),
): boolean => {
  if (seen.has(node)) return false;
  const next = new Set(seen);
  next.add(node);
  if (Array.isArray(node))
    return node.some((child) => containsResource(child, next));
  if (!isObject(node)) return false;
  if (declaresResource(node)) return true;
  return Object.values(node).some((child) => containsResource(child, next));
};

// A schema map entry named `$id` is a definition name, not a resource
// boundary; only a subschema declaring `$id` as a string URI is one.
const declaresResource = (node: unknown): boolean =>
  isObject(node) && typeof node.$id === "string";

type CollectedReference = {
  readonly reference: string;
  readonly resourceTokens: readonly string[];
};

const referenceKey = (entry: {
  reference: string;
  resourceTokens: readonly string[];
}): string => JSON.stringify(entry.resourceTokens) + " " + entry.reference;

// Collect references from schema positions only: literal annotation data
// (examples, defaults) is not a schema, so any `$ref` inside it must not
// influence advertised normalization. Each reference is recorded together
// with the resource it belongs to (the outer schema, or the nearest
// enclosing subschema declaring a string `$id`).
const collectSchemaReferences = (
  node: unknown,
  collected: CollectedReference[],
  path: readonly string[],
  resourceTokens: readonly string[],
): void => {
  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      collectSchemaReferences(child, collected, [...path, String(index)], resourceTokens),
    );
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#"))
    collected.push({ reference: node.$ref, resourceTokens });
  for (const [key, child] of Object.entries(node)) {
    if (
      !schemaMaps.has(key) &&
      !schemaArrays.has(key) &&
      !schemaChildren.has(key)
    )
      continue;
    if (schemaMaps.has(key) && isObject(child)) {
      for (const [name, grandChild] of Object.entries(child)) {
        const childPath = [...path, key, name];
        collectSchemaReferences(
          grandChild,
          collected,
          childPath,
          declaresResource(grandChild) ? childPath : resourceTokens,
        );
      }
    } else if (Array.isArray(child)) {
      child.forEach((grandChild, index) => {
        const childPath = [...path, key, String(index)];
        collectSchemaReferences(
          grandChild,
          collected,
          childPath,
          declaresResource(grandChild) ? childPath : resourceTokens,
        );
      });
    } else {
      const childPath = [...path, key];
      collectSchemaReferences(
        child,
        collected,
        childPath,
        declaresResource(child) ? childPath : resourceTokens,
      );
    }
  }
};

// A reference whose target position the structural pass removed cannot keep
// its `$ref` (clients that compile the schema could not load it), so the
// widened target is substituted at every caller instead — scoped to the
// resource that owns the reference, composed with any `$ref` siblings, and
// applied recursively so replacements containing further dangling references
// are substituted too.
const applyDangling = (
  node: unknown,
  dangling: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
  resourceTokens: readonly string[],
  path: readonly string[],
  seen: ReadonlySet<string>,
  draft07: boolean,
): unknown => {
  if (Array.isArray(node)) {
    let changed = false;
    const mapped = node.map((child, index) => {
      const childPath = [...path, String(index)];
      const next = applyDangling(
        child,
        dangling,
        declaresResource(child) ? childPath : resourceTokens,
        childPath,
        seen,
        draft07,
      );
      changed ||= next !== child;
      return next;
    });
    return changed ? mapped : node;
  }
  if (!isObject(node)) return node;
  const resourceKey = JSON.stringify(resourceTokens);
  const refMap = dangling.get(resourceKey);
  if (refMap !== undefined && typeof node.$ref === "string") {
    const replacement = refMap.get(node.$ref);
    if (replacement !== undefined) {
      const seenKey = `${resourceKey} ${node.$ref}`;
      if (!seen.has(seenKey)) {
        const applied = applyDangling(
          replacement,
          dangling,
          resourceTokens,
          path,
          new Set([...seen, seenKey]),
          draft07,
        );
        const { $ref: _ref, ...siblings } = node;
        const existingAllOf = Array.isArray(siblings.allOf)
          ? siblings.allOf
          : [];
        if (Object.keys(siblings).length === 0) return applied;
        // Draft-07 ignores $ref siblings entirely; 2020-12 applies both.
        return draft07
          ? applied
          : { ...siblings, allOf: [applied, ...existingAllOf] };
      }
    }
  }
  let changed = false;
  const rebuilt: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    if (schemaMaps.has(key) && isObject(child)) {
      let mapChanged = false;
      const map: Record<string, unknown> = {};
      for (const [name, grandChild] of Object.entries(child)) {
        const childPath = [...path, key, name];
        const next = applyDangling(
          grandChild,
          dangling,
          declaresResource(grandChild) ? childPath : resourceTokens,
          childPath,
          seen,
          draft07,
        );
        map[name] = next;
        mapChanged ||= next !== grandChild;
      }
      rebuilt[key] = mapChanged ? map : child;
      changed ||= mapChanged;
    } else if (schemaArrays.has(key) || schemaChildren.has(key)) {
      const childPath = [...path, key];
      const next = applyDangling(
        child,
        dangling,
        declaresResource(child) ? childPath : resourceTokens,
        childPath,
        seen,
        draft07,
      );
      rebuilt[key] = next;
      changed ||= next !== child;
    } else {
      rebuilt[key] = child;
    }
  }
  return changed ? rebuilt : node;
};

// Positive local references can address positions the structural walk never
// visits (for example a root-level annotation), which would leave the target's
// empty-string literal advertised. Normalize every referenced target too, and
// resolve each reference within its own resource. All change decisions are
// computed against the immutable source schema before any writeback, so
// rewriting one target cannot mask another target's change.
const normalizeReferencedTargets = (
  advertised: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const collected: CollectedReference[] = [];
  collectSchemaReferences(source, collected, [], []);
  const writes: Array<
    [
      readonly string[],
      unknown,
      { reference: string; resourceTokens: readonly string[] },
    ]
  > = [];
  const dangling = new Map<string, Map<string, unknown>>();
  const fileDangling = (
    entry: { reference: string; resourceTokens: readonly string[] },
    replacement: unknown,
  ): void => {
    const key = JSON.stringify(entry.resourceTokens);
    const refs = dangling.get(key) ?? new Map<string, unknown>();
    refs.set(entry.reference, replacement);
    dangling.set(key, refs);
  };
  const processed = new Set<string>();
  const reachedTargets: Array<
    [readonly string[], readonly string[]]
  > = [];
  const queue = [...collected];
  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined) continue;
    const key = referenceKey(entry);
    if (processed.has(key)) continue;
    processed.add(key);
    const resource =
      entry.resourceTokens.length === 0
        ? source
        : (pathValue(source, entry.resourceTokens) as unknown);
    if (!isObject(resource)) continue;
    const resolved = resolveLocalSchemaReference(resource, entry.reference);
    if (resolved === undefined || !isObject(resolved.value)) continue;
    // Targets reached only through other unwalked targets need the same
    // treatment as directly referenced ones. A target that itself declares a
    // resource starts a new reference scope for everything inside it.
    const outerTokens = [...entry.resourceTokens, ...resolved.tokens];
    const nested: CollectedReference[] = [];
    collectSchemaReferences(
      resolved.value,
      nested,
      outerTokens,
      declaresResource(resolved.value) ? outerTokens : entry.resourceTokens,
    );
    for (const nestedEntry of nested) {
      const nestedKey = referenceKey(nestedEntry);
      if (!processed.has(nestedKey)) queue.push(nestedEntry);
    }
    const presented = pathValue(advertised, outerTokens);
    if (presented === undefined) {
      // The position was removed by the structural pass; substitute the
      // widened target at its callers rather than dangling.
      const removed = normalizeAdvertisedSchema(
        resolved.value,
        resource,
        new Set([scopedReference(resource, entry.reference)]),
      );
      fileDangling(entry, removed.schema);
      continue;
    }
    // The reference makes this position executable even when unchanged.
    reachedTargets.push([outerTokens, entry.resourceTokens]);
    const result = normalizeAdvertisedSchema(
      resolved.value,
      resource,
      new Set([scopedReference(resource, entry.reference)]),
    );
    if (!result.changed) continue;
    // Prefer the presented node at the same position so injected property
    // descriptions survive the writeback.
    const replacement = isObject(presented)
      ? normalizeAdvertisedSchema(
          presented,
          resource,
          new Set([scopedReference(resource, entry.reference)]),
        ).schema
      : result.schema;
    writes.push([outerTokens, replacement, entry]);
  }
  // Apply shallow writes first so a parent replacement cannot restore an
  // un-widened descendant; deeper writes then override their own positions.
  // A write whose position an earlier ancestor replacement removed joins the
  // dangling set instead of resurrecting the removed path.
  writes.sort((a, b) => a[0].length - b[0].length);
  for (const [tokens, replacement, entry] of writes) {
    if (pathValue(advertised, tokens) === undefined) {
      fileDangling(entry, replacement);
      continue;
    }
    assignAtPath(advertised, tokens, replacement);
  }
  if (dangling.size === 0) return advertised;
  // Park replacements that must not be duplicated inline: those declaring or
  // containing a nested resource (identifiers would collide), and those stuck
  // in cycles among removed targets (inlining cannot terminate). Each parked
  // schema lives in its owning resource's `$defs`, and callers receive a
  // fragment reference that resolves within that same resource.
  const draft07 =
    typeof source.$schema === "string" && source.$schema.includes("draft-07");
  let parked = 0;
  const parkTarget = (
    resourceKey: string,
    replacement: unknown,
  ): string => {
    const resourceTokens = JSON.parse(resourceKey) as readonly string[];
    const defsPath = [...resourceTokens, "$defs"];
    const defs = (
      isObject(pathValue(advertised, defsPath))
        ? pathValue(advertised, defsPath)
        : {}
    ) as Record<string, unknown>;
    let name: string | undefined = undefined;
    for (const [existing, value] of Object.entries(defs)) {
      if (isDeepStrictEqual(value, replacement)) {
        name = existing;
        break;
      }
    }
    if (name === undefined) {
      name = `advertisedRelocated${parked}`;
      parked += 1;
      while (name in defs) name = `${name}x`;
      defs[name] = replacement;
      if (pathValue(advertised, defsPath) === undefined)
        assignAtPath(advertised, defsPath, defs);
      // Only the parked definition itself is executable; never walk the
      // `$defs` map, whose entry names are definition names, not keywords.
      reachedTargets.push([[...defsPath, name], resourceTokens]);
    }
    return name;
  };
  for (const [resourceKey, refMap] of [...dangling]) {
    for (const [reference, replacement] of [...refMap]) {
      if (!isObject(replacement) || !containsResource(replacement)) continue;
      const name = parkTarget(resourceKey, replacement);
      refMap.set(reference, { $ref: `#/$defs/${name}` });
    }
  }
  // Removed targets that reference each other can never terminate inline
  // substitution; park the whole cyclic group and let executable processing
  // retarget their internal references at the parked definitions.
  for (const [resourceKey, refMap] of [...dangling]) {
    const danglingRefsIn = (
      node: unknown,
      out: Set<string>,
      seen: ReadonlySet<unknown>,
    ): void => {
      if (seen.has(node)) return;
      const nextSeen = new Set(seen);
      nextSeen.add(node);
      if (Array.isArray(node)) {
        for (const child of node) danglingRefsIn(child, out, nextSeen);
        return;
      }
      if (!isObject(node)) return;
      if (typeof node.$ref === "string" && refMap.has(node.$ref))
        out.add(node.$ref);
      for (const [key, child] of Object.entries(node)) {
        if (
          !schemaMaps.has(key) &&
          !schemaArrays.has(key) &&
          !schemaChildren.has(key)
        )
          continue;
        danglingRefsIn(child, out, nextSeen);
      }
    };
    const isParked = (value: unknown): boolean =>
      isObject(value) &&
      typeof value.$ref === "string" &&
      value.$ref.startsWith("#/$defs/advertisedRelocated");
    const edges = new Map<string, Set<string>>();
    for (const [reference, replacement] of refMap) {
      const contained = new Set<string>();
      danglingRefsIn(replacement, contained, new Set());
      edges.set(reference, contained);
    }
    const cyclic = (
      start: string,
      node: string,
      path: ReadonlySet<string>,
    ): boolean => {
      if (node === start && path.size > 0) return true;
      if (path.has(node)) return false;
      const nextPath = new Set(path);
      nextPath.add(node);
      for (const target of edges.get(node) ?? [])
        if (cyclic(start, target, nextPath)) return true;
      return false;
    };
    for (const reference of [...refMap.keys()]) {
      const current = refMap.get(reference);
      if (!isObject(current) || isParked(current)) continue;
      if (containsResource(current)) continue; // parked above
      if (!cyclic(reference, reference, new Set())) continue;
      const name = parkTarget(resourceKey, current);
      refMap.set(reference, { $ref: `#/$defs/${name}` });
    }
  }
  let presented = applyDangling(
    advertised,
    dangling,
    [],
    [],
    new Set(),
    draft07,
  );
  // Executable target subtrees may themselves contain dangling references
  // (reference chains); substitute those as well.
  for (const [tokens, entryResourceTokens] of reachedTargets) {
    const subtree = pathValue(presented, tokens);
    if (!isObject(subtree)) continue;
    const next = applyDangling(
      subtree,
      dangling,
      entryResourceTokens,
      tokens,
      new Set(),
      draft07,
    );
    if (next !== subtree)
      assignAtPath(presented as Record<string, unknown>, tokens, next);
  }
  return presented as Record<string, unknown>;
};

const assignAtPath = (
  container: Record<string, unknown> | unknown[],
  tokens: readonly string[],
  replacement: unknown,
): void => {
  if (tokens.length === 0) return;
  const [head, ...rest] = tokens;
  if (Array.isArray(container)) {
    if (head === undefined || !/^(?:0|[1-9]\d*)$/u.test(head)) return;
    const index = Number(head);
    if (index >= container.length) return;
    if (rest.length === 0) {
      container[index] = replacement;
      return;
    }
    const child = container[index];
    const copy = Array.isArray(child)
      ? [...child]
      : isObject(child)
        ? { ...child }
        : undefined;
    if (copy === undefined) return;
    container[index] = copy;
    assignAtPath(copy, rest, replacement);
    return;
  }
  if (head === undefined) return;
  if (rest.length === 0) {
    container[head] = replacement;
    return;
  }
  const child = container[head];
  const copy = Array.isArray(child)
    ? [...child]
    : isObject(child)
      ? { ...child }
      : undefined;
  if (copy === undefined) return;
  container[head] = copy;
  assignAtPath(copy, rest, replacement);
};

const advertisedSchema = (
  input: unknown,
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const schema = normalizeAdvertisedSchema(input).schema as Record<
    string,
    unknown
  >;
  return normalizeReferencedTargets(schema, source);
};

/** Describe canonical input fields and present the root as one object. */
export const presentInputJsonSchema = (  root: Record<string, unknown>,
  describeProperty: (property: string) => string | undefined,
): Record<string, unknown> => {
  const flattened = flattenRootObjectUnion(root);
  const described = describeSchema(flattened, flattened, describeProperty);
  if (!isObject(described))
    return advertisedSchema(flattened, root);
  const {
    dependencies: _dependencies,
    dependentRequired: _dependentRequired,
    ...presentation
  } = described;
  const rootDependencies = isObject(described.dependentRequired)
    ? described.dependentRequired
    : isObject(described.dependencies)
      ? described.dependencies
      : undefined;
  const dependencyGuidance =
    rootDependencies === undefined
      ? []
      : Object.entries(rootDependencies).flatMap(([property, partners]) =>
          Array.isArray(partners) &&
          partners.every((partner) => typeof partner === "string")
            ? [
                `When ${property} is provided, also provide ${partners.join(" and ")}.`,
              ]
            : [],
        );
  if (dependencyGuidance.length === 0)
    return advertisedSchema(presentation, root);
  const description = [
    typeof presentation.description === "string"
      ? presentation.description
      : undefined,
    ...dependencyGuidance,
  ].filter((text) => text !== undefined);
  return advertisedSchema(
    {
      ...presentation,
      description: description.join(" "),
    },
    root,
  );
};
