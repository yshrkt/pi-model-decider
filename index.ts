import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { register } from "./src/extension.ts";
export default function (pi: ExtensionAPI) {
  register(pi);
}
