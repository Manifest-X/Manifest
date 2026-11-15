import { defineConfig } from 'vitest/config'
import { budget } from './tests/helpers/time-budget.js'

// Wall-clock-sensitive files run on their own, one at a time, after the main pool.
const serial = [
    'tests/data-optimistic.test.js',
    'tests/data-paging.test.js',
    'tests/data-query-live-order.test.js',
    'tests/minify-reactive-reads.test.js',
    'tests/virtual-measure.test.js',
]

const shared = { environment: 'node', testTimeout: budget(5000), hookTimeout: budget(10000) }

export default defineConfig({
    test: {
        projects: [
            { test: { ...shared, name: 'unit', include: ['tests/**/*.test.js'], exclude: serial } },
            { test: { ...shared, name: 'serial', include: serial, fileParallelism: false, sequence: { groupOrder: 1 } } },
        ],
    },
})
