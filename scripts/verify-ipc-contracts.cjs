#!/usr/bin/env node
/**
 * Verify that the sidecar's command declarations have not drifted from the typed
 * frontend contracts.
 *
 * This is a source-level drift check, not a replacement for the runtime contract
 * tests in src/lib/*.test.ts. It exists because the sidecar (plain JS, validated
 * at runtime) and the frontend (typed, validated at compile time) describe the same
 * command surface in two files that nothing forces to stay in sync outside of tests
 * that both files happen to be loaded by.
 *
 * Usage:
 *   node scripts/verify-ipc-contracts.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function sorted(values) {
  return [...new Set(values)].sort();
}

function assertEqual(label, actual, expected) {
  const actualJson = JSON.stringify(sorted(actual));
  const expectedJson = JSON.stringify(sorted(expected));
  if (actualJson !== expectedJson) {
    throw new Error(`${label} drifted.\nExpected: ${expectedJson}\nActual:   ${actualJson}`);
  }
}

/**
 * Extracts single-quoted string literals from a `new Set([...])` block.
 *
 * The block must contain nothing but quoted literals, commas, and whitespace. A spread,
 * variable reference, or any other non-literal token would let the sidecar recognize a
 * command that this check silently never compares, so unsupported syntax fails loudly
 * instead of being ignored.
 */
function extractQuotedValues(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Could not find ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Could not find ${endMarker}`);
  const body = source.slice(start + startMarker.length, end);
  const withoutLiterals = body.replace(/'[^']*'/g, '');
  if (/\S/.test(withoutLiterals.replace(/,/g, ''))) {
    throw new Error(
      `Unsupported syntax between ${startMarker} and ${endMarker}: only quoted literals and ` +
        `commas are allowed, found "${withoutLiterals.trim()}"`,
    );
  }
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** Finds the `{ ... }` body following `marker`, matching braces so nested objects don't confuse it. */
function findObjectBody(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Could not find ${marker}`);
  const bodyStart = source.indexOf('{', start);
  if (bodyStart < 0) throw new Error(`Could not find object body for ${marker}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not close object for ${marker}`);
}

/**
 * Strips `//` line comments, respecting single-quoted strings so a literal containing
 * `//` is never mistaken for a comment. These declarations use only single quotes.
 */
function stripLineComments(body) {
  let result = '';
  let inString = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "'" && body[index - 1] !== '\\') inString = !inString;
    if (!inString && char === '/' && body[index + 1] === '/') {
      const newline = body.indexOf('\n', index);
      index = newline < 0 ? body.length : newline - 1;
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * Splits an object body into top-level `key: value` entries, respecting nested
 * brace/bracket/paren depth so a nested object's own colons and commas are not
 * mistaken for entry boundaries.
 */
function splitTopLevelEntries(rawBody) {
  const body = stripLineComments(rawBody);
  const entries = [];
  let depth = 0;
  let entryStart = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '{' || char === '[' || char === '(') depth += 1;
    if (char === '}' || char === ']' || char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      entries.push(body.slice(entryStart, index));
      entryStart = index + 1;
    }
  }
  entries.push(body.slice(entryStart));

  const result = [];
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const colon = entry.indexOf(':');
    if (colon < 0) throw new Error(`Could not parse object entry: "${entry}"`);
    const key = entry.slice(0, colon).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
      throw new Error(`Could not parse object entry key: "${entry}"`);
    }
    result.push([key, entry.slice(colon + 1).trim()]);
  }
  return result;
}

/** Extracts the top-level keys of an object, e.g. every command name in COMMAND_SCHEMA. */
function extractObjectKeys(source, marker) {
  return splitTopLevelEntries(findObjectBody(source, marker)).map(([key]) => key);
}

/**
 * Extracts, per command, every field name declared inside its value.
 *
 * Used for both `COMMAND_SCHEMA` (whose value is `{ required: [...], optional: [...] }`,
 * so the field names are quoted string literals) and `FIELD_TYPES` (whose value is a flat
 * object of `field: 'type'`, so the field names are the value's own object keys).
 */
function extractFieldsByCommand(source, marker, { fieldsAsQuotedLiterals }) {
  const entries = splitTopLevelEntries(findObjectBody(source, marker));
  const byCommand = new Map();
  for (const [command, value] of entries) {
    const fields = fieldsAsQuotedLiterals
      ? [...value.matchAll(/'([^']+)'/g)].map((match) => match[1])
      : splitTopLevelEntries(value.replace(/^\{/, '').replace(/\}$/, '')).map(([field]) => field);
    byCommand.set(command, fields);
  }
  return byCommand;
}

function verifyIpcContracts(root, log = console) {
  const contractsPath = path.join(root, 'src', 'lib', 'ipc-contracts.ts');
  const sidecarPath = path.join(root, 'sidecar', 'foundry-sidecar.js');
  const outcomesPath = path.join(root, 'src', 'lib', 'operation-outcome.ts');
  const deadlinesPath = path.join(root, 'src', 'lib', 'ipc-deadlines.ts');

  const typed = fs.readFileSync(contractsPath, 'utf8');
  const sidecar = fs.readFileSync(sidecarPath, 'utf8');
  const outcomes = fs.readFileSync(outcomesPath, 'utf8');
  const deadlines = fs.readFileSync(deadlinesPath, 'utf8');

  return verifyIpcContractSources({ typed, sidecar, outcomes, deadlines }, log);
}

/** Pure core of the check, taking file contents directly so it can be exercised with fixtures. */
function verifyIpcContractSources({ typed, sidecar, outcomes, deadlines }, log = console) {
  const typedCommands = extractQuotedValues(typed, 'new Set<SidecarCommandName>([', ']);');
  const sidecarCommands = extractQuotedValues(sidecar, 'const KNOWN_COMMANDS = new Set([', ']);');
  const sidecarSchemas = extractObjectKeys(sidecar, 'const COMMAND_SCHEMA =');
  const effectCommands = extractObjectKeys(outcomes, 'COMMAND_EFFECTS:');
  const deadlineCommands = extractObjectKeys(deadlines, 'IPC_COMMAND_DEADLINES_MS:');

  const schemaFieldsByCommand = extractFieldsByCommand(sidecar, 'const COMMAND_SCHEMA =', {
    fieldsAsQuotedLiterals: true,
  });
  const fieldTypesByCommand = extractFieldsByCommand(sidecar, 'const FIELD_TYPES =', {
    fieldsAsQuotedLiterals: false,
  });

  assertEqual('sidecar command allowlist', sidecarCommands, typedCommands);
  assertEqual('sidecar command schema', sidecarSchemas, typedCommands);
  assertEqual('operation effect classification', effectCommands, typedCommands);
  assertEqual('IPC deadline classification', deadlineCommands, typedCommands);

  for (const [command, fields] of fieldTypesByCommand) {
    const schemaFields = schemaFieldsByCommand.get(command);
    if (!schemaFields) {
      throw new Error(`FIELD_TYPES declares an unknown command: ${command}`);
    }
    for (const field of fields) {
      if (!schemaFields.includes(field)) {
        throw new Error(
          `FIELD_TYPES.${command} declares field "${field}" that is not in COMMAND_SCHEMA.${command} ` +
            `(required/optional: ${JSON.stringify(schemaFields)})`,
        );
      }
    }
  }

  log.log(`IPC contracts verified: ${typedCommands.length} commands`);
  return typedCommands.length;
}

module.exports = {
  assertEqual,
  extractFieldsByCommand,
  extractObjectKeys,
  extractQuotedValues,
  findObjectBody,
  splitTopLevelEntries,
  verifyIpcContractSources,
  verifyIpcContracts,
};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  try {
    verifyIpcContracts(root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
