const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const contractsPath = path.join(root, 'src', 'lib', 'ipc-contracts.ts');
const sidecarPath = path.join(root, 'sidecar', 'foundry-sidecar.js');
const outcomesPath = path.join(root, 'src', 'lib', 'operation-outcome.ts');
const deadlinesPath = path.join(root, 'src', 'lib', 'ipc-deadlines.ts');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

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

function extractQuotedValues(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Could not find ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Could not find ${endMarker}`);
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function extractObjectKeys(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Could not find ${marker}`);
  const bodyStart = source.indexOf('{', start);
  if (bodyStart < 0) throw new Error(`Could not find object body for ${marker}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = source.slice(bodyStart + 1, index);
        const keys = [];
        let nestedDepth = 0;
        for (const line of body.split('\n')) {
          const trimmed = line.trim();
          if (nestedDepth === 0) {
            const match = trimmed.match(/^([A-Za-z][A-Za-z0-9]*)\s*:/);
            if (match) keys.push(match[1]);
          }
          nestedDepth += (line.match(/{/g) || []).length;
          nestedDepth -= (line.match(/}/g) || []).length;
        }
        return keys;
      }
    }
  }
  throw new Error(`Could not close object for ${marker}`);
}

const typed = read(contractsPath);
const sidecar = read(sidecarPath);
const outcomes = read(outcomesPath);
const deadlines = read(deadlinesPath);

const typedCommands = extractQuotedValues(typed, 'new Set<SidecarCommandName>([', ']);');
const sidecarCommands = extractQuotedValues(sidecar, 'const KNOWN_COMMANDS = new Set([', ']);');
const sidecarSchemas = extractObjectKeys(sidecar, 'const COMMAND_SCHEMA =');
const sidecarFieldTypes = extractObjectKeys(sidecar, 'const FIELD_TYPES =');
const effectCommands = extractObjectKeys(outcomes, 'COMMAND_EFFECTS:');
const deadlineCommands = extractObjectKeys(deadlines, 'IPC_COMMAND_DEADLINES_MS:');

assertEqual('sidecar command allowlist', sidecarCommands, typedCommands);
assertEqual('sidecar command schema', sidecarSchemas, typedCommands);
for (const command of sidecarFieldTypes) {
  if (!sidecarSchemas.includes(command)) {
    throw new Error(`sidecar field-type declarations contain unknown command: ${command}`);
  }
}
assertEqual('operation effect classification', effectCommands, typedCommands);
assertEqual('IPC deadline classification', deadlineCommands, typedCommands);

console.log(`IPC contracts verified: ${typedCommands.length} commands`);
