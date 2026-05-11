#!/usr/bin/env node
import { main } from '../manifest.test.mjs';

main(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode || 0);
}).catch((err) => {
    console.error('mnfst-test:', err.message || err);
    process.exit(2);
});
