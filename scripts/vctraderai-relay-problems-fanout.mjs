#!/usr/bin/env node
/**
 * Fan the fork-#59 relay change across every vctraderai `internal-http-client.ts`.
 *
 * WHAT #59 FIXED, once: the BFF accumulates every contract violation into
 * `problems[]` with a `fix_hint` each, and its `retry_suggestion` tells the model
 * to read them — but the relay read only code/message/retry_suggestion and dropped
 * `problems` and `error_codes`. The agent was told to consult a list it was never
 * given, and learned ONE RULE PER ATTEMPT.
 *
 * WHY A SCRIPT AND NOT 130 HAND EDITS. The copies are NOT identical: hashing the
 * blobs at lineage head 967b50ca gives 33 DISTINCT VARIANTS across 140 files. What
 * IS uniform is the relay core — every file in the edit set carries byte-identical
 * anchors — so an anchored, asserted edit applies cleanly where a copy-paste would
 * silently skew.
 *
 * WHY THE BLOCKS ARE READ FROM THE REFERENCE FILE rather than embedded here: the
 * reference is the already-reviewed #59 result. Embedding a second copy would
 * create a source of drift — the exact defect class this change is fixing one
 * level up. If the reference ever changes, re-running this script propagates it.
 *
 * A SHARED MODULE IS THE RIGHT END STATE and this is not it. `packages/*` is
 * bundled by the Dockerfile, so one module is structurally possible — but it needs
 * `pnpm-lock.yaml` regenerated (the build runs `--frozen-lockfile`, and an
 * unlocked new workspace package fails it outright), which is not a change to ride
 * on a bake day. That is its own later PR.
 *
 * Re-runnable: a file already carrying the marker is reported as `skip`, so the
 * next bake runs this rather than hand-editing.
 *
 *   node scripts/vctraderai-relay-problems-fanout.mjs [--check]
 *
 * `--check` reports without writing (exit 1 if any file would change).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const REFERENCE = "extensions/vctraderai-create-strategy/src/internal-http-client.ts";
const MARKER = "readProblems";
const CHECK_ONLY = process.argv.includes("--check");

/** Slice `[from, to)` out of the reference, proving both ends were found. */
function span(src, from, to, label) {
  const a = src.indexOf(from);
  if (a === -1) {
    throw new Error(`reference is missing the ${label} start anchor`);
  }
  const b = src.indexOf(to, a + from.length);
  if (b === -1) {
    throw new Error(`reference is missing the ${label} end anchor`);
  }
  return src.slice(a, b + to.length);
}

const reference = readFileSync(path.join(REPO_ROOT, REFERENCE), "utf8");
if (!reference.includes(MARKER)) {
  throw new Error(`reference ${REFERENCE} does not carry the change; nothing to fan out`);
}

// The four blocks, taken verbatim from the reviewed reference.
const TYPES = span(
  reference,
  "  retrySuggestion?: string;\n  /**\n   * The server's FULL problem list",
  "export type BffProblem = {\n  code: string;\n  message: string;\n  fixHint?: string;\n};",
  "types",
);
const HELPERS = span(
  reference,
  "/** Read `problems[]` off the envelope",
  "  return codes.length > 0 ? codes : undefined;\n}",
  "helpers",
);
const RENDER = span(
  reference,
  "/**\n * Render the problem list for the thrown message",
  'return lines.join("\\n");\n}',
  "renderProblems",
);

// (anchor, replacement) pairs. Each anchor must appear EXACTLY ONCE or the file
// is left untouched and reported — a partial edit is worse than none.
const EDITS = [
  {
    label: "BffError fields + BffProblem type",
    anchor: "  retrySuggestion?: string;\n};",
    replace: () => TYPES,
  },
  {
    label: "readProblems / readErrorCodes helpers",
    anchor: "/**\n * Read the server's structured error envelope off a failed response.",
    replace: (a) => `${HELPERS}\n\n${a}`,
  },
  {
    label: "extraction in readBffErrorDetail",
    anchor: "        ? suggestion.slice(0, MAX_ERROR_BODY_CHARS)\n        : undefined,\n  };",
    replace: (a) =>
      a.replace(
        "  };",
        "    // Same envelope record as `code` / `message` / `retry_suggestion`.\n" +
          "    problems: readProblems(envelope.problems),\n" +
          "    errorCodes: readErrorCodes(envelope.error_codes),\n  };",
      ),
  },
  {
    label: "renderProblems + the thrown message",
    anchor: "export class BffRequestError extends Error {",
    replace: (a) => `${RENDER}\n\n${a}`,
  },
  {
    // STRUCTURAL, not textual. Prettier wraps this `super(...)` differently from
    // file to file because the extension's name changes the line length, so the
    // reference's three-line form and the one-line form elsewhere are the same
    // code. A literal anchor taken from the reference matched 0 of 130 — which
    // the per-anchor assert caught, rather than the script editing nothing and
    // reporting success.
    label: "the message itself",
    anchor: / {4}super\(\s*detail\.retrySuggestion[\s\S]*?\n {4}\);/,
    replace: () =>
      "    const head = detail.retrySuggestion\n" +
      "      ? `${summary} — retry_suggestion: ${detail.retrySuggestion}`\n" +
      "      : summary;\n" +
      '    // The suggestion says "read problems[].fix_hint". This makes it true.\n' +
      "    const rendered = detail.problems?.length\n" +
      "      ? renderProblems(detail.problems, MAX_ERROR_BODY_CHARS)\n" +
      '      : "";\n' +
      "    super(rendered ? `${head}\\nproblems:\\n${rendered}` : head);",
  },
];

const targets = globSync("extensions/*/src/internal-http-client.ts", { cwd: REPO_ROOT }).toSorted();

let changed = 0;
let skipped = 0;
const notEligible = [];
const failed = [];

for (const rel of targets) {
  const abs = path.join(REPO_ROOT, rel);
  let src = readFileSync(abs, "utf8");

  if (src.includes(MARKER)) {
    skipped += 1;
    continue;
  }
  // The nine relays of a DIFFERENT shape (BffRequestError only, no BffError and
  // no readBffErrorDetail) are not in the edit set. They are left alone by
  // design, not by accident — see the PR body.
  if (!src.includes("export type BffError") || !src.includes("async function readBffErrorDetail")) {
    notEligible.push(rel);
    continue;
  }

  let ok = true;
  for (const edit of EDITS) {
    const hits =
      edit.anchor instanceof RegExp
        ? (src.match(new RegExp(edit.anchor.source, "g")) ?? []).length
        : src.split(edit.anchor).length - 1;
    if (hits !== 1) {
      failed.push(`${rel}: anchor "${edit.label}" found ${hits}x`);
      ok = false;
      break;
    }
  }
  if (!ok) {
    continue;
  }

  for (const edit of EDITS) {
    const matched =
      edit.anchor instanceof RegExp ? (src.match(edit.anchor) ?? [""])[0] : edit.anchor;
    src = src.replace(edit.anchor, edit.replace(matched));
  }
  if (src.split(MARKER).length - 1 < 1) {
    failed.push(`${rel}: marker absent after edit`);
    continue;
  }
  if (!CHECK_ONLY) {
    writeFileSync(abs, src, "utf8");
  }
  changed += 1;
}

console.log(`targets      ${targets.length}`);
console.log(`already done ${skipped}`);
console.log(`edited       ${changed}${CHECK_ONLY ? " (check only, nothing written)" : ""}`);
console.log(`not eligible ${notEligible.length} (different relay shape, left alone by design)`);
for (const rel of notEligible) {
  console.log(`  - ${rel}`);
}
if (failed.length) {
  console.error(`\nFAILED ${failed.length}:`);
  for (const line of failed) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}
if (CHECK_ONLY && changed > 0) {
  process.exit(1);
}
