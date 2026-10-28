import { performSetup, parseSetupArgs } from './setup.js';

try { await performSetup(process.argv[2], parseSetupArgs(process.argv.slice(3))); }
catch (error) { console.error(`suwin setup: ${error.message}`); process.exitCode = 1; }
