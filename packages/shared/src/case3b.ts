export const CASE3B_QUEUE = 'case3b.decrement.queue';
export const CASE3B_CLIENT = 'CASE3B_CLIENT';

export const CASE3B_DECREMENT_PATTERN = 'case3b.decrement';

export type Case3bDecrementPayload = {
  amount: number;
};

export type Case3bDecrementResult = {
  before: number;
  after: number;
  applied: boolean;
};

export const CASE3B_REDIS_BALANCE_KEY = 'case3b:account:1:balance';

export const CASE3B_REDIS_DECREMENT_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]))
if cur == nil then return {-1, -1, 0} end
local amt = tonumber(ARGV[1])
if cur < amt then return {cur, cur, 0} end
local newBal = redis.call('DECRBY', KEYS[1], amt)
return {cur, newBal, 1}
`.trim();

export const CASE3B_REDIS_FLUSH_INTERVAL_MS = 1000;
