// Binaries embedded at build time (esbuild binary loader).
// scrcpy-server v3.3 — Apache-2.0, © Genymobile / Romain Vimont. Unmodified release build.
import SERVER from "../assets/scrcpy-server-v3.3.jar";
// Annex Wi-Fi bridge (bridge/AnnexBridge.java → javac → d8 → smali, packaged as a jar).
import BRIDGE from "../bridge/prebuilt/annex-bridge.jar";

export const SCRCPY_SERVER: Uint8Array = SERVER;
export const SCRCPY_VERSION = "3.3";
export const BRIDGE_JAR: Uint8Array = BRIDGE;
