'use strict';
/**
 * GitHub Actions' workflow commands and files, for the image entry points
 * (#600). Run outside Actions, as when rehearsing against a local registry,
 * outputs and the summary go to stdout instead.
 */
const fs = require('node:fs');

/** Logs an annotation. Actions reads `%`, CR and LF in its data as escapes, so they are escaped here. */
function annotate(level, message) {
  const data = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const line = `::${level}::${data}`;

  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Sets the step's outputs. */
function setOutputs(outputs) {
  const lines = Object.entries(outputs)
    .map(([name, value]) => `${name}=${value}\n`)
    .join('');

  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

/** Adds Markdown to the job's summary. */
function appendSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is unset`);

  return value;
}

module.exports = { annotate, appendSummary, requiredEnv, setOutputs };
