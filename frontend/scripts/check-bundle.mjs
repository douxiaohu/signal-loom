import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDirectory = fileURLToPath(new URL("../dist/assets/", import.meta.url));
const budgetBytes = 250 * 1024;
const assetNames = await readdir(assetsDirectory);
const javascriptAssets = assetNames.filter((name) => name.endsWith(".js"));
const sizes = await Promise.all(
  javascriptAssets.map(async (name) => (await stat(join(assetsDirectory, name))).size),
);
const totalBytes = sizes.reduce((total, size) => total + size, 0);

if (totalBytes > budgetBytes) {
  throw new Error(
    `JavaScript bundle is ${totalBytes} bytes, exceeding the ${budgetBytes}-byte raw budget.`,
  );
}

console.log(`JavaScript raw bundle: ${totalBytes} / ${budgetBytes} bytes`);
