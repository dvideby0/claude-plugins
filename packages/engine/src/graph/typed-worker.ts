import { parentPort, workerData } from "node:worker_threads";
import { analyseTypes } from "./typed.js";

const { projectRoot } = workerData as { projectRoot: string };

try {
  parentPort?.postMessage({ analysis: analyseTypes(projectRoot) });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
