#!/usr/bin/env node
import { main } from '../manifest.types.mjs';

main(process.argv.slice(2)).catch((err) => {
    console.error('mnfst-types:', err.message || err);
    process.exit(1);
});
