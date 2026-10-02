import { handleDynamicSpotApi } from "../_shared/dynamicSpotApi.ts";
import type { CloudflareEnv } from "../_shared/env.ts";

export const onRequest: PagesFunction<CloudflareEnv> = (context) =>
  handleDynamicSpotApi(context, "retry");
