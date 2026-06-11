import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const files = [
  ["src/recorder/recorder.html", "dist/recorder/recorder.html"],
  ["src/recorder/clipboard-picker.html", "dist/recorder/clipboard-picker.html"]
];

for (const [from, to] of files) {
  const target = resolve(to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolve(from), target);
}
