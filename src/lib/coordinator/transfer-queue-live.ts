/**
 * The transfer queue read with the real fetch (#4380), shared by the coordinator page's
 * server action and the monitor lane's probe so both ask the endpoint the same way. The
 * rules (the deadline, the strict parse) are `readTransferQueue`'s. Server only.
 */
import { readTransferQueue, type TransferQueueReading } from "@/lib/coordinator/transfer-queue";

export function liveTransferQueueRead(): Promise<TransferQueueReading> {
  // The deadline's signal is the one `readTransferQueue` hands in, named here so the
  // outbound deadline guard sees it.
  return readTransferQueue((url, init) => fetch(url, { headers: init.headers, signal: init.signal }));
}
