#!/usr/bin/env node
import { runCli } from '../lib/cli.js';

// runCli never rejects, and setting exitCode rather than calling exit() lets
// a piped report finish writing before the process ends (#1093).
process.exitCode = await runCli(process.argv.slice(2), { stderr: process.stderr, stdout: process.stdout });
