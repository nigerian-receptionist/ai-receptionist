/**
 * Backpressure gate for mic frames (M8).
 *
 * The capture worklet posts a 20 ms frame every 20 ms unconditionally. On a
 * weak uplink the socket buffer would grow unbounded (memory blowup, and the
 * server would receive minutes-stale audio). The hook consults
 * `shouldSendMicFrame` with the live `WebSocket.bufferedAmount` and drops
 * (with a counter) above the limit instead of sending.
 */

export const MIC_BUFFERED_AMOUNT_LIMIT = 64 * 1024;

export function shouldSendMicFrame(
  bufferedAmount: number,
  limit: number = MIC_BUFFERED_AMOUNT_LIMIT,
): boolean {
  return bufferedAmount <= limit;
}
