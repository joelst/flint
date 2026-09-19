#!/usr/bin/env node
/**
 * Sidecar process entry. Installs stdout protection before any other Flint or
 * dependency module evaluates, then loads the JSON-lines command loop.
 *
 * Run with: node sidecar/foundry-sidecar.js
 *
 * Command allowlists and handlers live in foundry-sidecar-main.js. Do not add
 * static imports here other than protocol-stdout — ESM evaluates every import
 * before this module body runs.
 */
import { protectProtocolStdout } from './protocol-stdout.js';

protectProtocolStdout();
await import('./foundry-sidecar-main.js');
