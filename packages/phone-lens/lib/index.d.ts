import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

//#region src/index.d.ts
/**
* phone-lens host plugin.
*
* Boots the receiver inside the dsh process so uploads can flow straight
* into `ctx.attachments` (and, from Phase 2 on, into agent inboxes) with no
* extra IPC. Everything registered here unwinds with the fiber.
*/
/**
 * phone-lens host plugin.
 *
 * Boots the receiver inside the dsh process so uploads can flow straight
 * into `ctx.attachments` (and, from Phase 2 on, into agent inboxes) with no
 * extra IPC. Everything registered here unwinds with the fiber.
 */
declare class PhoneLens extends Service {
  static inject: string[];
  static Config: z<any, any>;
  constructor(ctx: any, rawConfig: unknown);
}

//#endregion
//# sourceMappingURL=index.d.ts.map

export { PhoneLens as default };
//# sourceMappingURL=index.d.ts.map