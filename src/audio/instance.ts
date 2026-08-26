import { Engine } from "./engine";

/**
 * エンジンはアプリに1つ。React のライフサイクル（StrictMode の二重マウント含む）で
 * AudioContext が増えないよう、モジュールスコープに置いている。
 */
export const engine = new Engine();
