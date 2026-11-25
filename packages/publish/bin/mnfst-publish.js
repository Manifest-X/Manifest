#!/usr/bin/env node
import { main, isJsonMode, jsonFailure } from '../manifest.publish.mjs';

main().catch((err) => {
  if (isJsonMode()) process.stdout.write(JSON.stringify(jsonFailure(err)) + '\n');
  console.error('mnfst-publish:', err && err.message ? err.message : err);
  process.exit(1);
});
