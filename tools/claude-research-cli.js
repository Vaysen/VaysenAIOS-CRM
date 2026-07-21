#!/usr/bin/env node
'use strict';

// Development entrypoint. The canonical implementation lives inside the backend
// Docker build context so the exact same CLI is available at /app/tools in Linux.
const cli = require('../backend/tools/claude-research-cli');
process.exitCode = cli.main();
