import { marciaRoute } from "@/lib/mcp-booking/next-route";

export const dynamic = "force-dynamic";

/**
 * Marcia's `move` operation (#3543). Reached only through `McpBookingGateway`
 * (worker/index.ts): the public handler refuses every `/api/internal/mcp-` path,
 * and the handler checks the gateway secret and Marcia's signed lead token itself.
 */
export const POST = marciaRoute("move");
