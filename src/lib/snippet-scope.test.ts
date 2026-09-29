import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "svelte/compiler";
import { findUnresolvedSnippetReferences, lineAtOffset } from "./snippet-scope";

function parseFragment(source: string): unknown {
  return (parse(source, { modern: true }) as { fragment: unknown }).fragment;
}

function unresolved(source: string): string[] {
  return findUnresolvedSnippetReferences(parseFragment(source)).map((ref) => ref.name);
}

describe("findUnresolvedSnippetReferences", () => {
  it("accepts a snippet rendered from the fragment that declares it", () => {
    expect(unresolved(`<div>{#snippet a()}<b>x</b>{/snippet}{@render a()}</div>`)).toEqual([]);
  });

  it("accepts a snippet rendered from a descendant fragment", () => {
    expect(
      unresolved(`{#snippet a()}<b>x</b>{/snippet}<div><span>{@render a()}</span></div>`),
    ).toEqual([]);
  });

  it("accepts a snippet rendered before its declaration in the same fragment", () => {
    expect(unresolved(`<div>{@render a()}{#snippet a()}<b>x</b>{/snippet}</div>`)).toEqual([]);
  });

  it("accepts a snippet rendered from inside a control-flow block", () => {
    expect(unresolved(`{#snippet a()}<b>x</b>{/snippet}{#if ok}{@render a()}{/if}`)).toEqual([]);
  });

  it("accepts a snippet that renders itself recursively", () => {
    expect(
      unresolved(`{#snippet a(n)}{#if n}{@render a(n - 1)}{/if}{/snippet}{@render a(2)}`),
    ).toEqual([]);
  });

  it("accepts a snippet passed to a component and rendered from its own parameter", () => {
    expect(
      unresolved(`{#snippet row(item)}{@render item()}{/snippet}<List>{@render row(x)}</List>`),
    ).toEqual([]);
  });

  it("accepts a snippet name shadowed by an each binding", () => {
    // `{#each}` rebinds the name, so the inner render is not the outer snippet.
    expect(
      unresolved(`<div>{#snippet cell()}<b/>{/snippet}</div>{#each rows as cell}{@render cell()}{/each}`),
    ).toEqual([]);
  });

  it("accepts a snippet name shadowed by an await binding or a const tag", () => {
    expect(
      unresolved(`<div>{#snippet v()}<b/>{/snippet}</div>{#await p then v}{@render v()}{/await}`),
    ).toEqual([]);
    expect(
      unresolved(`<div>{#snippet c()}<b/>{/snippet}</div>{#if ok}{@const c = f}{@render c()}{/if}`),
    ).toEqual([]);
  });

  it("ignores names that are not snippets declared in this file", () => {
    // Props, parameters and script values are out of this analysis's model, and
    // the compiler reports genuinely missing names on its own.
    expect(unresolved(`{#snippet a()}<b/>{/snippet}{@render children?.()}{@render a()}`)).toEqual(
      [],
    );
    expect(unresolved(`<div>{@render missing()}</div>`)).toEqual([]);
  });

  it("does not mistake a property name for a snippet reference", () => {
    expect(
      unresolved(`{#snippet a()}<b/>{/snippet}<div title={obj.a} data-x={{ a: 1 }.b}>{@render a()}</div>`),
    ).toEqual([]);
  });

  it("rejects a snippet rendered from a sibling fragment", () => {
    // This is the shape that throws `ReferenceError: a is not defined` at
    // runtime while compiling and type-checking cleanly.
    const source = `<div>{#snippet a()}<b>x</b>{/snippet}</div><form>{@render a()}</form>`;
    const refs = findUnresolvedSnippetReferences(parseFragment(source));
    expect(refs.map((ref) => ref.name)).toEqual(["a"]);
    expect(source.slice(refs[0].start, refs[0].start + 1)).toBe("a");
  });

  it("rejects a snippet rendered from outside the block that declares it", () => {
    expect(unresolved(`{#if ok}{#snippet a()}<b>x</b>{/snippet}{/if}{@render a()}`)).toEqual(["a"]);
  });

  it("rejects an out-of-scope snippet passed as an attribute value", () => {
    // Same ReferenceError, without a `{@render}` tag anywhere near it.
    expect(unresolved(`<div>{#snippet a()}<b/>{/snippet}</div><Icon glyph={a} />`)).toEqual(["a"]);
  });

  it("returns nothing for templates with no snippets at all", () => {
    expect(unresolved(`<div>{value}</div>`)).toEqual([]);
  });

  it("tolerates malformed and non-fragment input", () => {
    expect(findUnresolvedSnippetReferences(null)).toEqual([]);
    expect(findUnresolvedSnippetReferences({ type: "SnippetBlock", expression: null })).toEqual([]);
    expect(
      findUnresolvedSnippetReferences([
        { type: "SnippetBlock", expression: { type: "Identifier", name: "a" }, body: null },
        { type: "Identifier", name: "a" },
      ]),
    ).toEqual([{ name: "a", start: 0 }]);
  });
});

describe("lineAtOffset", () => {
  it("counts newlines up to the offset", () => {
    const source = "a\nbb\nccc";
    expect(lineAtOffset(source, 0)).toBe(1);
    expect(lineAtOffset(source, 2)).toBe(2);
    expect(lineAtOffset(source, 5)).toBe(3);
  });

  it("clamps out-of-range offsets instead of throwing", () => {
    expect(lineAtOffset("a\nb", -5)).toBe(1);
    expect(lineAtOffset("a\nb", 9999)).toBe(2);
    expect(lineAtOffset("a\nb", Number.NaN)).toBe(1);
  });
});

describe("+page.svelte snippet scopes", () => {
  // `+page.svelte` is `@ts-nocheck` and has no component tests, so an
  // out-of-scope snippet reference there would otherwise only surface as a
  // blank view, in a build where the user is unlikely to open the inspector.
  it("references every snippet from a scope that can see it", () => {
    const source = readFileSync(join(process.cwd(), "src", "routes", "+page.svelte"), "utf8");
    const refs = findUnresolvedSnippetReferences(parseFragment(source));
    expect(refs.map((ref) => `${ref.name} (line ${lineAtOffset(source, ref.start)})`)).toEqual([]);
  });
});
