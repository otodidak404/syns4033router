const fs = require("node:fs");
const path = require("node:path");

const backendDir = path.resolve(__dirname, "..");
const srcDir = path.join(backendDir, "src");
const distDir = path.join(backendDir, "dist");
const profilesDir = path.join(srcDir, "automation", "profiles");

fs.rmSync(distDir, { recursive: true, force: true });
fs.cpSync(srcDir, distDir, {
  recursive: true,
  filter(source) {
    if (source === profilesDir || source.startsWith(profilesDir + path.sep)) {
      return false;
    }
    return !source.endsWith(".ts") && !source.endsWith(".tsx");
  },
});
