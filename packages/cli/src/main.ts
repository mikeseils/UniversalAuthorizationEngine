#!/usr/bin/env node
import { createProcessIo } from "./io.js";
import { run } from "./run.js";

// Process wiring only: parse argv, delegate to `run()`, and translate the
// returned exit code. All command logic lives behind injected io (ADR-0013).
const exitCode = await run(process.argv.slice(2), createProcessIo());
process.exitCode = exitCode;
