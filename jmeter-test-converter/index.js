import { program } from "commander";
import convertPostmanToPlaywright from "./src/converter.js";

console.log("Working"); 

program
  .command("convert <postmanCollectionPath> <output>")
  .action(convertPostmanToPlaywright);

program.parse(process.argv);

// If no arguments are provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
