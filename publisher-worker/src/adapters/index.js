import { PocketBaseCMSPublisher } from "./pocketbase-cms.js";
import { NextJsPublisher, WebhookPublisher } from "./signed-http.js";
import { WordPressPublisher } from "./wordpress.js";
import { PublishError } from "../net.js";

const REGISTRY = { pocketbase_cms: PocketBaseCMSPublisher, nextjs_api: NextJsPublisher, webhook: WebhookPublisher, wordpress: WordPressPublisher };

export function createAdapter(type, deps) {
  const Cls = REGISTRY[type];
  if (!Cls) throw new PublishError("NOT_CONFIGURED", `Unknown publisher type ${type}`);
  return new Cls(deps);
}

export { PocketBaseCMSPublisher, NextJsPublisher, WebhookPublisher, WordPressPublisher };
