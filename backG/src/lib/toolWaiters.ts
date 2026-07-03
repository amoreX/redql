// Parked-promise registry. The agent loop AWAITS a tool result that arrives via a
// SEPARATE request (submitToolResult) from the device. This bridges the two:
// the loop parks a promise keyed by toolCallId; submitToolResult resolves it.

type Waiter = { resolve: (content: string) => void; reject: (err: Error) => void };

const waiters = new Map<string, Waiter>();

// The loop calls this and awaits — blocks until the device submits the result
// (or times out so a dead device can't hang the turn forever).
export function waitForToolResult(
  toolCallId: string,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(toolCallId);
      reject(new Error(`tool result timeout (${toolCallId})`));
    }, timeoutMs);
    waiters.set(toolCallId, {
      resolve: (c) => {
        clearTimeout(timer);
        resolve(c);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
  });
}

// submitToolResult calls this → wakes the parked loop. Returns false if no one
// was waiting for that id (unknown/expired).
export function resolveToolResult(toolCallId: string, content: string): boolean {
  const w = waiters.get(toolCallId);
  if (!w) return false;
  waiters.delete(toolCallId);
  w.resolve(content);
  return true;
}
