import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDirectory = fileURLToPath(new URL("../dist/assets/", import.meta.url));
// Keep the reading app and the optional Assembly engine under separate limits.
const budgetBytes = 260 * 1024;
const assemblyBudgetBytes = 36 * 1024;
const shareBudgetBytes = 16 * 1024;
const assetNames = await readdir(assetsDirectory);
const javascriptAssets = assetNames.filter((name) => name.endsWith(".js") && !name.startsWith("admin-"));
const assets = await Promise.all(
  javascriptAssets.map(async (name) => ({ name, size: (await stat(join(assetsDirectory, name))).size })),
);
const assemblyBytes = assets.filter(({ name }) => name.startsWith("assembly-runtime-")).reduce((sum, { size }) => sum + size, 0);
const shareBytes = assets.filter(({ name }) => name.startsWith("shareCard-")).reduce((sum, { size }) => sum + size, 0);
const totalBytes = assets.reduce((total, { size }) => total + size, 0) - assemblyBytes - shareBytes;

if (totalBytes > budgetBytes) {
  throw new Error(
    `JavaScript bundle is ${totalBytes} bytes, exceeding the ${budgetBytes}-byte raw budget.`,
  );
}
if (shareBytes > shareBudgetBytes) {
  throw new Error(`Share export bundle is ${shareBytes} bytes, exceeding its ${shareBudgetBytes}-byte raw budget.`);
}
if (assemblyBytes > assemblyBudgetBytes) {
  throw new Error(`Assembly bundle is ${assemblyBytes} bytes, exceeding its ${assemblyBudgetBytes}-byte raw budget.`);
}

console.log(`Reading JavaScript: ${totalBytes} / ${budgetBytes} bytes; deferred Assembly: ${assemblyBytes} / ${assemblyBudgetBytes} bytes; deferred share export: ${shareBytes} / ${shareBudgetBytes} bytes`);
