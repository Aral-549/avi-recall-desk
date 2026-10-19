#!/usr/bin/env node
import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
});
