// Wall-clock budgets scale on slow or shared machines (CI sets TEST_TIME_SCALE).
export const budget = (ms) => ms * (Number(process.env.TEST_TIME_SCALE) || 1)
