const { startBot } = require("./src/app/bot");
const { failStartup } = require("./src/app/startup");

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  startBot().catch((error) => failStartup(error));
}
