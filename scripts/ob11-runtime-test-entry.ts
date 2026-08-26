import Config from "../src/config/config";
Config.registerConfig();
export { dispatchOb11Api } from "../src/transport/ob11/dispatcher";
export { encodeNativeMessage, normalizeFileReference, normalizeMessageSegments } from "../src/transport/ob11/message_segments";
export { getActionCapability } from "../src/transport/ob11/capability_catalog";
export { decodeEscapedNewlines } from "../src/utils/string";
export { replyToSender } from "../src/utils/utils";
