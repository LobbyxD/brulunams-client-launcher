const fs = require("fs/promises");
const path = require("path");

async function main() {
  await fs.rm(path.resolve(__dirname, "..", "dist"), { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
