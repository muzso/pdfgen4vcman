#!/usr/bin/env node

// Node.js builtin packages
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { accessSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";

// Dependencies from this package
import { generatePdfs } from "../lib/generator.js";

// 3rd-party packages
// commandline arguments parser
import { program, Option } from "commander";
// allow use of "extra" plugins
import puppeteer from "puppeteer-extra";
// the Stealth plugin is required to avoid CDN anti-scraping techniques
// (i.e. puppeteer and headless browser detection -> HTTP 403 responses)
import pluginStealth from "puppeteer-extra-plugin-stealth";
// PDF generator (to merge Chromium generated PDFs into a single PDF)
import { PageSizes, PDFDocument } from "pdf-lib";
// logger
import { format, loggers, transports } from "winston";
const logger = loggers.add("mainLogger");
import { LEVEL, MESSAGE, SPLAT } from "triple-beam";
// replacement for "require.main === module"
import esMain from "es-main";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// defaults for the commandline options
// (see description at the end of this file or by using the "--help" commandline option)
const DEFAULT_TIMEOUT = 60000;
const DEFAULT_IDLE_CONCURRENCY = 2;
const DEFAULT_RETRIES = 0;
const DEFAULT_PDF_TIMEOUT = 60000;
const DEFAULT_TOC_LIMIT = 0;
const DEFAULT_WAIT_TIME = 0;
const DEFAULT_FILENAME = "manual.pdf";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_LOG_LEVEL = "info";
const HTTP_4xx_RETRY_STATUS_CODES = Array.from(Array(100).keys(), (x) => x + 400).filter((x) => ![ 401, 404, 407 ].includes(x))
const HTTP_5xx_RETRY_STATUS_CODES = Array.from(Array(100).keys(), (x) => x + 500)
const HTTP_RETRY_STATUS_CODES = HTTP_4xx_RETRY_STATUS_CODES.concat(HTTP_5xx_RETRY_STATUS_CODES);
const DEFAULT_HTTP_ERROR_DOMAINS = [ ".volvocars.com" ];
const PAGE_SIZES = Object.keys(PageSizes);
const DEFAULT_PAGE_SIZE = "A4";
const DEFAULT_LENIENCY = 0;
const DEFAULT_URL_DOMAINS = [ ".volvocars.com" ];
const DEFAULT_NEW_BROWSER_PER_URLS = 100;

// return the current date & time in "YYYY-MM-DD HH:MI:SS" format (in GMT timezone)
function getFormattedTimestamp() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const hour = now.getUTCHours();
  const minutes = now.getUTCMinutes();
  const seconds = now.getUTCSeconds();
  const timestampStr = year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0")
    + " "
    + String(hour).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0")
  ;
  return timestampStr;
}

function cleanup(options, userDirectory, pdfDirectory) {
  logger.verbose(`cleanup(): options.userDir = ${options.userDir}, userDirectory = ${userDirectory}, options.pdfDir = ${options.pdfDir}, pdfDirectory = ${pdfDirectory}`);
  if (typeof options.userDir === "undefined" && userDirectory) {
    try {
      accessSync(userDirectory);
      logger.verbose(`cleanup(): deleting temporary userDirectory: ${userDirectory}`);
      rmSync(userDirectory, { recursive: true, force: true });
    } catch (err) {
      logger.verbose(`cleanup(): temporary userDirectory was not found (so not deleting): ${userDirectory}`);
    }
  }
  if (typeof options.pdfDir === "undefined" && pdfDirectory) {
    try {
      accessSync(pdfDirectory);
      logger.verbose(`cleanup(): deleting temporary pdfDirectory: ${pdfDirectory}`);
      rmSync(pdfDirectory, { recursive: true, force: true });
    } catch (err) {
      logger.verbose(`cleanup(): temporary pdfDirectory was not found (so not deleting): ${pdfDirectory}`);
    }
  }
}

async function main(proc, url, options, command) {
  // this a merge of the simple and prettyPrint builtin formats
  // and added a timestamp to the beginning of the message
  const mySimpleLoggerFormat = format((info) => {
    // info[{LEVEL, MESSAGE, SPLAT}] are enumerable here. Since they
    // are internal, we remove them before util.inspect so they
    // are not printed.
    const stripped = Object.assign({}, info);
    // Remark (indexzero): update this technique in April 2019
    // when node@6 is EOL
    delete stripped[LEVEL];
    delete stripped[MESSAGE];
    delete stripped[SPLAT];
    delete stripped["level"];
    delete stripped["message"];

    const stringifiedRest = inspect(stripped, {
      depth: Infinity,
      colors: true,
      maxArrayLength: Infinity
    });
  
    const timestamp = new Date().toISOString();
    const padding = info.padding && info.padding[info.level] || "";
    if (stringifiedRest !== "{}") {
      info[MESSAGE] = `${timestamp} ${info.level}:${padding} ${info.message} ${stringifiedRest}`;
    } else {
      info[MESSAGE] = `${timestamp} ${info.level}:${padding} ${info.message}`;
    }
  
    return info;
  });
  logger.configure({
    level: options.logLevel,
    format: format.combine( format.splat(), format.colorize(), mySimpleLoggerFormat() ),
    transports: [ new transports.Console() ]
  });
    
  logger.info("main(): starting");
  logger.verbose("main(): parameters: ", { url: url, options: options } );

  // to avoid CDN anti-scraping measures (HTTP 403 responses)
  puppeteer.use(pluginStealth());

  let userDirectory = undefined;
  if (typeof options.userDir !== "undefined") {
    try {
      await access(options.userDir);
      userDirectory = options.userDir;
    } catch (err) {
      logger.error(`main(): the path specified with --user-dir does not exist: ${options.userDir}`);
      throw err;
    }
  } else {
    try {
      userDirectory = await mkdtemp(join(tmpdir(), "pdfgen4vcman-userDir-"));
    } catch (err) {
      logger.error("main(): failed to create temporary directory for Chromium userDir, ", err);
      throw err;
    }
  }

  let pdfDirectory = undefined;
  if (typeof options.pdfDir !== "undefined") {
    try {
      await access(options.pdfDir);
      pdfDirectory = options.pdfDir;
    } catch (err) {
      logger.error(`main(): the path specified with --pdf-dir does not exist: ${options.pdfDir}`);
      throw err;
    }
  } else {
    try {
      pdfDirectory = await mkdtemp(join(tmpdir(), "pdfgen4vcman-pdfDir-"));
    } catch (err) {
      logger.error("main(): failed to create temporary directory for intermediary PDF files, ", err);
      throw err;
    }
  }

  proc.on("uncaughtExceptionMonitor", async (err, origin) => {
    logger.verbose("main(): uncaughtExceptionMonitor, ", { origin: origin, error: err });
    cleanup(options, userDirectory, pdfDirectory);
    proc.exit(1);
  });
  proc.on("SIGINT", async () => {
    // graceful shutdown, i.e. clean up allocated resources
    logger.verbose("main(): SIGINT handler");
    cleanup(options, userDirectory, pdfDirectory);
    proc.exit(1);
  });
  // https://stackoverflow.com/questions/10021373/what-is-the-windows-equivalent-of-process-onsigint-in-node-js
  if (proc.platform === "win32") {
    const rl = createInterface({
      input: proc.stdin,
      output: proc.stdout
    });
  
    rl.on("SIGINT", function () {
      proc.emit("SIGINT");
    });
  }

  if (command.args.length == 0) {
    logger.error("main(): no arguments, this code should never get executed");
    proc.exit(1);
  }

  const parsedPath = parse(options.output ? options.output : DEFAULT_FILENAME);
  const outputfile = join(parsedPath.dir, parsedPath.name + "_" + options.timestamp.replaceAll(/[:]/g, "-").replaceAll(/[ /\\]+/g, "_") + parsedPath.ext);

  const pdfDoc = await PDFDocument.create();

  let pageUrls = undefined;
  if (options.toc === true) {
    logger.info("main(): generating the ToC page");
    pageUrls = await generatePdfs(puppeteer, [ url ], userDirectory, pdfDirectory, pdfDoc, options, true);
    logger.info(`main(): number of page URLs in ToC: ${pageUrls ? pageUrls.length : 0}`);
    if (options.tocLimit > 0) {
      pageUrls = pageUrls.slice(0, options.tocLimit);
    }
  } else {
    logger.info("main(): no ToC page, generating directly a single content page");
    pageUrls = [ url ];
  }

  logger.info(`main(): number of page URLs to be processed: ${pageUrls ? pageUrls.length : 0}`);
  if (pageUrls && pageUrls.length > 0) {
    await generatePdfs(puppeteer, pageUrls, userDirectory, pdfDirectory, pdfDoc, options, false);
  }

  const pdfBytes = await pdfDoc.save();
  await writeFile(outputfile, pdfBytes);

  cleanup(options, userDirectory, pdfDirectory);
  
  logger.info("main(): finished");
}

export default async function cli(proc) {
  const timestamp = getFormattedTimestamp();
  const collect = (value, previous)  => {
    return previous.concat( [ value ] );
  };
  const commaSeparatedList = (value, dummyPrevious) => {
    return value.split(",").filter((x) => x.length > 0);
  };
  const commaSeparatedIntList = (value, dummyPrevious) => {
    const parsedArray = value.split(",").filter((x) => x.length > 0).map((x) => parseInt(x, 10));
    if (parsedArray.some((x) => isNaN(x))) {
      throw new commander.InvalidArgumentError(`"${value}" was parsed as a comma-separated list and one of its elements is not a number.`);
    }
    return parsedArray;
  };
  const optParser = (prefix, value, previous) => {
    const idx = value.indexOf(",");
    if (idx >= 0) {
      return previous.concat( [ prefix + value.substring(0, idx), value.substring(idx + 1) ] );
    } else {
      return previous.concat( [ prefix + value ] );
    }
  }
  const intParser = (value, dummyPrevious) => {
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) {
      throw new commander.InvalidArgumentError(`"${value}" was parsed into "${parsedValue}" and it's not a number.`);
    }
    return parsedValue;
  }
  program
    .version(JSON.parse(readFileSync(__dirname + "/../package.json", "utf8")).version)
    .argument("<url>", "the URL for the table-of-contents page of the Volvo user manual")
    .option("-u, --url-domain-suffix <suffix1,suffix2,...>", "comma-separated list of domain suffixes used for filtering URLs for PDF generation", commaSeparatedList, DEFAULT_URL_DOMAINS)
    .option("-o, --output <filepath>", "path of the PDF file to be written")
    .option("-p, --proxy <proxy-spec>", "a proxy URL to be used for HTTP requests by the browser (can be specified multiple times)", collect, [])
    .option("-a, --user-agent <user-agent>", "the user-agent string used for HTTP requests by the browser", DEFAULT_USER_AGENT)
    .option("--browser-long-option <name[,value]>", "a long commandline option for the browser (skip the \"--\" prefix from the option name)", (value, previous) => { return optParser("--", value, previous); }, [])
    .option("--browser-short-option <name[,value]>", "a short commandline option for the browser (skip the \"-\" prefix from the option name)", (value, previous) => { return optParser("-", value, previous); }, [])
    .option("-t, --timeout <milliseconds>", "network timeout used for HTTP requests by the browser", intParser, DEFAULT_TIMEOUT)
    .option("-n, --no-toc", "do not treat the URL argument as a table-of-contents, i.e. do not generate PDFs for each link found on the page")
    .option("--toc-limit <limit>", "number of pages to process in the table-of-contents", intParser, DEFAULT_TOC_LIMIT)
    .option("--no-headless", "do not run the browser in headless mode")
    .option("-i, --insecure", "ignore SSL/TLS errors")
    .option("-l, --links", "include the \"Related documents\" and \"More in this topic\" sections in the generated content pages")
    .option("-r, --retries <number>", "number of retries to load a page without any errors", intParser, DEFAULT_RETRIES)
    .option("-e, --http-errors <statuscode1,statuscode2,...>", "comma-separated list of HTTP statuscodes that if received from a domain in the \"--domain\" list, triggers a retry for the given page", commaSeparatedIntList, [])
    .option("-m, --http-error-domain-suffixes <suffix1,suffix2,...>", "comma-separated list of domain suffixes to watch HTTP errors for", commaSeparatedList, DEFAULT_HTTP_ERROR_DOMAINS)
    .option("-d, --user-dir <path>", "path to a directory where the Chromium user profile (with cookies, cache) will be stored and kept even when the execution stops. If not specified, a random temporary directory is created for the duration of the run and is deleted, when execution stops.")
    .option("-f, --pdf-dir <path>", "path to a directory where the intermediary PDFs are stored and kept (even when the execution stops) and looked for. This option allows to continue an interrupted PDF generation process. If not specified, a random temporary directory is created for the duration of the run and is deleted, when execution stops.")
    .option("--force", "render pages and save them as PDF even if a PDF for the given URL already exists in the \"--pdf-dir\" directory")
    .option("-w, --wait-time <seconds>", "number of seconds to wait if we've tried all proxies and all resulted in HTTP errors and/or throttling", DEFAULT_WAIT_TIME)
    .option("--pdf-timeout <milliseconds>", "PDF generation timeout", DEFAULT_PDF_TIMEOUT)
    .option("--timestamp <string>", "the timestamp string used in the default filename and the table-of-contents page", timestamp)
    .option("-c, --leniency", "increase the leniency towards the server (i.e. save the page as PDF even despite some errors from the server), you can specify this option multiple times. This can speed up the overall PDF generation process, but might result in a couple of missing images.", (d, p) => { return p + 1 }, DEFAULT_LENIENCY)
    .option("-b, --new-browser-per-urls <number>", "start a new browser after having processed this many URLs, regardless of whether there were any HTTP errors", DEFAULT_NEW_BROWSER_PER_URLS)
    .addOption(new Option("--log-level <level>", "set the log level").choices(Object.keys(logger.levels)).default(DEFAULT_LOG_LEVEL))
    .addOption(new Option("--pdf-page-size <size>", "the page format/size for the PDF (as per puppeteer's API)").choices(PAGE_SIZES).default(DEFAULT_PAGE_SIZE))
    .addOption(new Option("--idle-concurrency <number>", "maximum number concurrent of network connections to be considered inactive").argParser(intParser).default(DEFAULT_IDLE_CONCURRENCY).hideHelp())
    .action(async(url, options, command) => {
      if (options.httpErrors.length == 0) {
        options.httpErrors = HTTP_RETRY_STATUS_CODES;
      }
      await main(proc, url, options, command);
    });
  await program.parseAsync(proc.argv);
}

if (esMain(import.meta)) {
  cli(process);
}
