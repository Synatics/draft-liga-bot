const { startBot } = require("./bot");
const { failStartup } = require("./startup");

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  startBot().catch((error) => failStartup(error));
}
