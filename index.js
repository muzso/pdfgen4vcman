#!/usr/bin/env node

// Node.js builtin packages
import process from "node:process";

// 3rd-party packages
import cli from "./bin/pdfgen4vcman-cli.js";
import { generatePdfs } from "./lib/generator.js";
// replacement for "require.main === module"
import esMain from "es-main";

export default generatePdfs;

if (esMain(import.meta)) {
  cli(process);
}
