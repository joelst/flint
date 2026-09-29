/**
 * Static scope analysis for Svelte snippets.
 *
 * Svelte 5 scopes `{#snippet name()}` to the fragment that declares it: the
 * name is visible to that fragment's other children and to their descendants,
 * but not to the declaring fragment's siblings. Referencing a snippet from a
 * sibling fragment compiles without any diagnostic and then throws
 * `ReferenceError: name is not defined` at runtime, unmounting the whole view.
 *
 * `+page.svelte` is `@ts-nocheck` and has no component tests, so nothing else
 * in the toolchain catches that. This module walks the parsed template and
 * reports references to a snippet declared in the same file that are out of
 * scope at the reference site.
 *
 * It is a best-effort guard, not a complete scope analysis, and it is honest
 * about both directions of that:
 *
 * - It does not model JavaScript function scopes. A parameter or local
 *   declaration inside an event handler that happens to share a snippet's name
 *   is reported even though it compiles and runs. A false report is visible
 *   immediately as a failing test, so it costs a moment rather than a bug.
 * - `collectPatternNames` walks every key of a binding construct, so a name
 *   merely *read* in a `{@const}` initializer or a default value is treated as
 *   bound for that fragment. That can hide a genuine out-of-scope reference to
 *   a snippet of the same name. Narrowing this to true declaration positions
 *   would make the guard strictly stronger.
 *
 * Names that are not declared as a snippet anywhere in the file are ignored:
 * they are props, snippet parameters, `{#each}` bindings, `{@const}` values or
 * ordinary `<script>` variables, none of which this analysis models. That keeps
 * the check quiet on idiomatic markup, at the cost of not reporting a render of
 * a snippet that simply does not exist — which the Svelte compiler and the
 * runtime both surface on their own.
 */

export interface UnresolvedSnippetReference {
  /** The snippet name referenced out of scope. */
  name: string;
  /**
   * Character offset of the reference. Template nodes carry no `loc`, so
   * callers that want a line number resolve the offset with {@link lineAtOffset}.
   */
  start: number;
}

/** 1-based line containing `offset` in `source`. */
export function lineAtOffset(source: string, offset: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 1;
  let line = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

interface FragmentNode {
  type: "Fragment";
  nodes?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFragment(value: unknown): value is FragmentNode {
  return isRecord(value) && value.type === "Fragment";
}

function identifierName(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "Identifier") return null;
  return typeof value.name === "string" ? value.name : null;
}

function snippetName(node: unknown): string | null {
  if (!isRecord(node) || node.type !== "SnippetBlock") return null;
  return identifierName(node.expression);
}

/** Every name bound by a destructuring pattern, parameter list or declaration. */
function collectPatternNames(pattern: unknown, into: Set<string>): void {
  if (Array.isArray(pattern)) {
    for (const entry of pattern) collectPatternNames(entry, into);
    return;
  }
  if (!isRecord(pattern)) return;
  const name = identifierName(pattern);
  if (name !== null) {
    into.add(name);
    return;
  }
  for (const [key, value] of Object.entries(pattern)) {
    if (key === "type" || key === "loc" || key === "parent") continue;
    collectPatternNames(value, into);
  }
}

/**
 * Names a node binds for its own subtree. Adding a name here only suppresses
 * reporting, so a name included in error costs a missed report, never a false
 * one — see the note on `collectPatternNames` in the module header.
 */
function bindingsIntroducedBy(node: Record<string, unknown>): string[] {
  const bound = new Set<string>();
  switch (node.type) {
    case "SnippetBlock":
      collectPatternNames(node.parameters, bound);
      break;
    case "EachBlock":
      collectPatternNames(node.context, bound);
      if (typeof node.index === "string") bound.add(node.index);
      break;
    case "AwaitBlock":
      collectPatternNames(node.value, bound);
      collectPatternNames(node.error, bound);
      break;
    default:
      break;
  }
  return [...bound];
}

/** Names `{@const}` tags bind for the whole fragment that contains them. */
function constTagBindings(nodes: readonly unknown[]): string[] {
  const bound = new Set<string>();
  for (const node of nodes) {
    if (!isRecord(node) || node.type !== "ConstTag") continue;
    collectPatternNames(node.declaration, bound);
  }
  return [...bound];
}

function collectSnippetNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectSnippetNames(child, into);
    return;
  }
  if (!isRecord(node)) return;
  const declared = snippetName(node);
  if (declared !== null) into.add(declared);
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "loc" || key === "parent") continue;
    collectSnippetNames(value, into);
  }
}

function nodeStart(node: unknown): number {
  if (!isRecord(node)) return 0;
  return typeof node.start === "number" ? node.start : 0;
}

/**
 * Collects every reference to a locally declared snippet that is not in scope
 * where it is used.
 *
 * `parse` is intentionally not called here so this module stays free of a
 * compiler dependency; callers pass an already-parsed modern Svelte AST
 * fragment.
 */
export function findUnresolvedSnippetReferences(fragment: unknown): UnresolvedSnippetReference[] {
  const declaredAnywhere = new Set<string>();
  collectSnippetNames(fragment, declaredAnywhere);
  if (declaredAnywhere.size === 0) return [];

  const unresolved: UnresolvedSnippetReference[] = [];

  function visitFragment(current: FragmentNode, inherited: ReadonlySet<string>): void {
    const nodes = Array.isArray(current.nodes) ? current.nodes : [];
    // Snippets declared directly in this fragment are visible to all of its
    // children regardless of order, so gather them before descending.
    // `{@const}` bindings are fragment-wide in the same way.
    const declared = nodes.map(snippetName).filter((name): name is string => name !== null);
    const bound = [...declared, ...constTagBindings(nodes)];
    const scope = bound.length > 0 ? new Set([...inherited, ...bound]) : inherited;
    for (const node of nodes) visit(node, scope);
  }

  function visit(node: unknown, scope: ReadonlySet<string>): void {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, scope);
      return;
    }
    if (!isRecord(node)) return;

    if (isFragment(node)) {
      visitFragment(node, scope);
      return;
    }

    const referenced = identifierName(node);
    if (referenced !== null) {
      if (declaredAnywhere.has(referenced) && !scope.has(referenced)) {
        unresolved.push({ name: referenced, start: nodeStart(node) });
      }
      return;
    }

    const introduced = bindingsIntroducedBy(node);
    const inner = introduced.length > 0 ? new Set([...scope, ...introduced]) : scope;

    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "loc" || key === "parent") continue;
      // A snippet's own name is declared by its parent fragment, and these
      // positions bind names rather than reading them.
      if (node.type === "SnippetBlock" && (key === "expression" || key === "parameters")) continue;
      if (node.type === "EachBlock" && key === "context") continue;
      if (node.type === "AwaitBlock" && (key === "value" || key === "error")) continue;
      // `a.b` and `{ b: 1 }` read `a`, not `b`.
      if (node.type === "MemberExpression" && key === "property" && node.computed !== true) continue;
      if (node.type === "Property" && key === "key" && node.computed !== true) continue;
      visit(value, inner);
    }
  }

  if (isFragment(fragment)) {
    visitFragment(fragment, new Set());
  } else {
    visit(fragment, new Set());
  }

  return unresolved;
}
