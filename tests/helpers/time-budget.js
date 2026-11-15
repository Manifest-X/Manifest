// Wall-clock budgets scale on slow or shared machines: TEST_TIME_SCALE (CI) or the current load per core.
import { cpus, loadavg } from 'os'

export const timeScale = () => Math.max(1, Number(process.env.TEST_TIME_SCALE) || 1, loadavg()[0] / (cpus().length || 1))
export const budget = (ms) => Math.ceil(ms * timeScale())
