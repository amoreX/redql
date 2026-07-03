// Cross-process tool-result rendezvous over Redis pub/sub.
//
// The agent loop parks a waiter for a toolCallId; the device's submitToolResult —
// which behind a load balancer may land on a DIFFERENT server process — publishes
// the result over Redis, which delivers it to whichever process is actually
// running the loop. This replaces the old in-process Map, which silently dropped
// the result whenever the two requests hit different processes (so "Redis pub/sub
// is in" no longer lies about multi-process: the tool round-trip is on Redis too).
//
// Ordering: the loop SUBSCRIBEs (awaited) BEFORE the tool is dispatched, so a
// result can never be published before we're listening.

import { createRedis } from "./redis.js";

const CHANNEL_PREFIX = "result:";
const channelFor = (toolCallId: string) => `${CHANNEL_PREFIX}${toolCallId}`;

// One connection in subscriber mode (parked loops), one normal connection to
// publish results. A subscriber-mode connection can't run ordinary commands, so
// they must be separate.
const sub = createRedis();
const pub = createRedis();

// toolCallId → resolver, for the calls THIS process is currently awaiting.
const handlers = new Map<string, (content: string) => void>();

sub.on("message", (channel, message) => {
  const id = channel.slice(CHANNEL_PREFIX.length);
  handlers.get(id)?.(message);
});

// Park for a tool's result. Subscribes FIRST (awaited) and returns once we're
// listening; the returned `.result` promise resolves when the device submits the
// result (or rejects on timeout so a dead device can't hang the turn forever).
// Call this BEFORE dispatching the tool so no result can slip past us.
export async function parkToolResult(
  toolCallId: string,
  timeoutMs = 120_000,
): Promise<{ result: Promise<string> }> {
  await sub.subscribe(channelFor(toolCallId)); // listening before dispatch
  const result = new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      handlers.delete(toolCallId);
      void sub.unsubscribe(channelFor(toolCallId));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`tool result timeout (${toolCallId})`));
    }, timeoutMs);
    handlers.set(toolCallId, (content) => {
      clearTimeout(timer);
      cleanup();
      resolve(content);
    });
  });
  return { result };
}

// Called by submitToolResult on ANY process → wakes the parked loop wherever it
// lives. PUBLISH returns the number of subscribers that received the message, so
// we still report whether a loop was actually waiting (0 → unknown/expired id) —
// now across processes instead of just this one's memory.
export async function resolveToolResult(
  toolCallId: string,
  content: string,
): Promise<boolean> {
  const receivers = await pub.publish(channelFor(toolCallId), content);
  return receivers > 0;
}
