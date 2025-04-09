#!/usr/bin/env node

// Node.js builtin packages
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { accessSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
const DEFAULT_RETRIES = 5;
const DEFAULT_PROXIES = [];
const DEFAULT_PDF_TIMEOUT = 60000;
const DEFAULT_PDF_CLEANUP_THRESHOLD = 0.008;
const DEFAULT_TOC_LIMIT = 0;
const DEFAULT_WAIT_TIME = 0;
const DEFAULT_FILENAME = "manual.pdf";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) {VERSION} Safari/537.36";
const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_RESOURCE_HTTP_4xx_RETRY_STATUS_CODES = Array.from(Array(100).keys(), (x) => x + 400).filter((x) => ![ 401, 404, 407 ].includes(x))
const HTTP_4xx_STATUS_CODES = Array.from(Array(100).keys(), (x) => x + 400)
const HTTP_5xx_STATUS_CODES = Array.from(Array(100).keys(), (x) => x + 500)
const DEFAULT_RESOURCE_HTTP_RETRY_STATUS_CODES = DEFAULT_RESOURCE_HTTP_4xx_RETRY_STATUS_CODES.concat(HTTP_5xx_STATUS_CODES);
const DEFAULT_PAGE_HTTP_RETRY_STATUS_CODES = HTTP_4xx_STATUS_CODES.concat(HTTP_5xx_STATUS_CODES);
const DEFAULT_RESOURCE_HTTP_ERROR_DOMAIN_SUFFIXES = [ ".volvocars.com" ];
const DEFAULT_RESOURCE_HTTP_ERROR_URL_EXCEPTIONS = [ new RegExp("^https?://[^/:]+\\.volvocars\\.com/api/site-navigation/location/predictions") ];
const PAGE_SIZES = Object.keys(PageSizes);
const DEFAULT_PAGE_SIZE = "A4";
const DEFAULT_LENIENCY = 0;
const DEFAULT_URL_DOMAINS = [ ".volvocars.com" ];
const DEFAULT_NEW_BROWSER_PER_URLS = 100;
// the defaults for "--browser-long-option" come from here:
// - https://www.browserless.io/blog/puppeteer-print
// - https://github.com/puppeteer/puppeteer/issues/2410
const DEFAULT_BROWSER_LONG_OPTIONS = [ "font-render-hinting,none", "force-color-profile,generic-rgb" ];
const DEFAULT_BROWSER_SHORT_OPTIONS = [];
const DEFAULT_GHOSTSCRIPT_PATH = "gs";
const DEFAULT_PDF_TOP_BOTTOM_MARGIN = 50;
const DEFAULT_PDF_LEFT_RIGHT_MARGIN = 0;

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

function buffer2string(input) {
  let ret;
  if (input !== null && input.constructor && input.constructor.name && input.constructor.name.toLowerCase() == "buffer") {
    ret = input.toString();
  } else {
    ret = input;
  }
  return ret;
}

async function main(proc, url, options, command) {
  // This a merge of the `simple` and `prettyPrint` builtin formats
  // and I've added a timestamp to the beginning of the message too.
  const mySimpleLoggerFormat = format((info) => {
    // info[{LEVEL, MESSAGE, SPLAT}] are enumerable here. Since they
    // are internal, we remove them before calling util.inspect()
    // so they are not printed.
    const stripped = Object.assign({}, info);
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
  // Note: we purposefully don't trust handleExceptions and handleRejections
  // on Winston's transport, because we want to do some cleanup.
  // See the uncaughtException and unhandledRejection handlers later on.
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

  proc.on("uncaughtException", (err, origin) => {
    logger.verbose("main(): uncaughtException, ", { origin: origin, error: err });
    cleanup(options, userDirectory, pdfDirectory);
    proc.exit(99);
  });
  proc.on("unhandledRejection", (reason, promise) => {
    logger.verbose("main(): unhandledRejection, ", { reason: reason, promise: promise });
    cleanup(options, userDirectory, pdfDirectory);
    proc.exit(98);
  });
  proc.on("SIGINT", async () => {
    // graceful shutdown, i.e. clean up allocated resources
    logger.verbose("main(): SIGINT handler");
    cleanup(options, userDirectory, pdfDirectory);
    proc.exit(97);
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

  if (!options.output || options.output.length == 0) {
    logger.error("main(): the output path must not be an empty string");
    proc.exit(2);
  }
  const outputfile = options.output;

  const pdfDoc = await PDFDocument.create();

  let exitCode = 0;
  let pageUrls = undefined;
  if (options.toc === true) {
    logger.info("main(): generating the ToC page");
    try {
      pageUrls = await generatePdfs(puppeteer, [ url ], userDirectory, pdfDirectory, pdfDoc, options, true).catch(e => {
        logger.error("main(): PDF generation for ToC page failed with a rejection: ", e);
        exitCode = 3;
      });
    } catch (err) {
      logger.error("main(): PDF generation for ToC page failed with an error: ", err);
      exitCode = 4;
    }
    logger.info(`main(): number of page URLs in ToC: ${pageUrls ? pageUrls.length : 0}`);
    if (options.tocLimit > 0 && pageUrls && pageUrls.length > 0) {
      pageUrls = pageUrls.slice(0, options.tocLimit);
    }
  } else {
    logger.info("main(): no ToC page, generating directly a single content page");
    pageUrls = [ url ];
  }

  logger.info(`main(): number of page URLs to be processed: ${pageUrls ? pageUrls.length : 0}`);
  if (pageUrls && pageUrls.length > 0) {
    let pdfGenerationResult = true;
    try {
      await generatePdfs(puppeteer, pageUrls, userDirectory, pdfDirectory, pdfDoc, options, false).catch((e) => {
        pdfGenerationResult = false;
        logger.error("main(): PDF generation for page URLs failed with a reject: ", e);
        exitCode = 5;
      });
    } catch (err) {
      pdfGenerationResult = false;
      logger.error("main(): PDF generation for page URLs failed with an error: ", err);
      exitCode = 6;
    }

    if (pdfGenerationResult) {
      if (pdfDoc.getPageCount() > 0) {
        const pdfBytes = await pdfDoc.save();
        await writeFile(outputfile, pdfBytes);
        logger.info(`main(): saved combined PDF to "${outputfile}"`);

        if (proc.platform == "linux" && options.pdfCleanup) {
          logger.info("main(): cleaning up empty pages");
          // https://ghostscript.readthedocs.io/en/latest/Devices.html#ink-coverage-output
          // Ghostscript ink coverage output.
          // The inkcov device considers each rendered pixel and whether it marks
          // the C, M, Y or K channels. So the percentages are a measure of how many
          // device pixels contain that ink.
          const cmd = options.ghostscriptPath;
          const cmdArgs = [ "-q", "-o", "-", "-sDEVICE=inkcov", outputfile ];
          logger.verbose(`main(): executing command: "${cmd} ${cmdArgs.join(" ")}"`);
          const spawnResult = spawnSync(cmd, cmdArgs, {
            stdio: "pipe"
          });
          if (spawnResult) {
            if (spawnResult.stdout) {
              spawnResult.stdout = buffer2string(spawnResult.stdout);
            }
            if (spawnResult.stderr) {
              spawnResult.stderr = buffer2string(spawnResult.stderr);
            }
            if (spawnResult.output) {
              spawnResult.output = spawnResult.output.map((x) => buffer2string(x));
            }
            if (spawnResult.status == 0 && typeof spawnResult.error == "undefined") {
              if (spawnResult.stdout) {
                logger.debug("main(): execution result: ", spawnResult);
                const lines = spawnResult.stdout
                  .replaceAll(/^\s+/mg, "")
                  .split(/[\r\n]+/)
                ;
                let removedPageCount = 0;
                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i];
                  if (line.length > 0) {
                    const fields = line.split(/\s+/);
                    if (fields.length >= 4) {
                      let sum = 0;
                      for (let k = 0; k < 4; k++) {
                        const val = parseFloat(fields[k]);
                        if (!isNaN(val)) {
                          sum += val;
                        } else {
                          logger.error(`main(): in GS's output in line #${i} the field #${k} is not a number: "${line}"`);
                          exitCode = 7;
                          sum = -1;
                          break;
                        }
                      }
                      logger.debug(`main(): page #${i} ink coverage sum: ${sum}`);
                      if (sum >= 0 && sum < options.pdfCleanupThreshold) {
                        logger.verbose(`main(): removing page #${i} from the output (ink coverage sum: ${sum})`);
                        pdfDoc.removePage(i - removedPageCount);
                        removedPageCount++;
                      }
                    } else {
                      logger.debug(`main(): line #${i} in GS output doesn't have 4 or more fields`);
                    }
                  } else {
                    logger.debug(`main(): line #${i} in GS output is empty`);
                  }
                };
                logger.debug(`main(): removed ${removedPageCount} pages`);
                if (removedPageCount > 0) {
                  const pdfBytes = await pdfDoc.save();
                  await writeFile(outputfile, pdfBytes);
                  logger.info(`main(): updated "${outputfile}" with ${removedPageCount} empty pages removed`);
                }
              } else {
                logger.error("main(): executing Ghostscript failed, spawnSync() returned a result with empty stdout (this should not be possible)");
                exitCode = 8;
                logger.verbose("main(): child process details: ", { cmd: cmd, args: cmdArgs, result: spawnResult } );
              }
            } else {
              logger.error(`main(): executing Ghostscript failed: exit status = ${spawnResult.status}`);
              exitCode = 9;
              if (spawnResult.error) {
                logger.error(`main(): error code = ${spawnResult.error.code}, error message = "${spawnResult.error.message}"`);
                exitCode = 10;
                if (spawnResult.error.code == "ENOENT") {
                  logger.error(`main(): ${spawnResult.error.code} means that the file at the "${cmd}" path was not found on the PATH or it could not be executed`);
                  exitCode = 11;
                  logger.info("main(): you can specify a different path for Ghostscript by using the \"--ghostscript-path\" option or disable use of Ghostscript to remove empty pages by using the \"--no-pdf-cleanup\" option");
                }
              }
              if (spawnResult.stdout && spawnResult.stdout.length > 0) {
                logger.error(`main(): stdout = ${spawnResult.stdout}`);
                exitCode = 12;
              }
              if (spawnResult.stderr && spawnResult.stderr.length > 0) {
                logger.error(`main(): stderr = ${spawnResult.stderr}`);
                exitCode = 13;
              }
              logger.info("main(): check \"https://nodejs.org/api/errors.html\" for description of error codes/messages that are not trivial (and/or set log level to \"verbose\" or higher to get more details on the error");
              logger.verbose("main(): child process details: ", { cmd: cmd, args: cmdArgs, result: spawnResult } );
            }
          } else {
            logger.error("main(): executing Ghostscript failed, spawnSync() returned empty result (this should not be possible)");
            exitCode = 14;
            logger.verbose("main(): child process details: ", { cmd: cmd, args: cmdArgs } );
          }
        }
      } else {
        logger.error("main(): no pages were produced in the combined PDF");
        exitCode = 15;
      }
    }
  }

  cleanup(options, userDirectory, pdfDirectory);
  
  logger.info("main(): finished");
  // This is not exactly "nice", but I've no idea (based on the documentation)
  // how Commander's parseAsync() handles the action's return value.
  if (exitCode > 0) {
    proc.exit(exitCode);
  }
}

export default async function cli(proc) {
  const timestamp = getFormattedTimestamp();
  const defaultTitleCaption = timestamp + " GMT";
  const parsedPath = parse(DEFAULT_FILENAME);
  const defaultOutput = join(parsedPath.dir, parsedPath.name + "_" + timestamp.replaceAll(/[:]/g, "-").replaceAll(/[ /\\]+/g, "_") + parsedPath.ext);
  const collect = (value, previous)  => {
    return previous.concat( [ value ] );
  };
  const collectRegExps = (value, previous)  => {
    return previous.concat( [ new RegExp(value) ] );
  };
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
    .option("-u, --url-domain-suffix <suffix>", "domain suffix used for filtering URLs for PDF generation (can be specified multiple times, extends the default list)", collect, DEFAULT_URL_DOMAINS)
    .option("-o, --output <filepath>", "path of the PDF file to be written", defaultOutput)
    .option("-p, --proxy <proxy-spec>", "a proxy URL to be used for HTTP requests by the browser (can be specified multiple times, extends the default list)", collect, DEFAULT_PROXIES)
    .option("-a, --user-agent <user-agent>", "the user-agent string used for HTTP requests by the browser")
    .option("--browser-long-option <name[,value]>", "a long commandline option for the browser (skip the \"--\" prefix from the option name) (can be specified multiple times, extends the default list)", collect, DEFAULT_BROWSER_LONG_OPTIONS)
    .option("--browser-short-option <name[,value]>", "a short commandline option for the browser (skip the \"-\" prefix from the option name) (can be specified multiple times, extends the default list)", collect, DEFAULT_BROWSER_SHORT_OPTIONS)
    .option("-t, --timeout <milliseconds>", "network timeout used for HTTP requests by the browser", intParser, DEFAULT_TIMEOUT)
    .option("-n, --no-toc", "do not treat the URL argument as a table-of-contents, i.e. do not generate PDFs for each link found on the page")
    .option("--toc-limit <limit>", "number of pages to process in the table-of-contents", intParser, DEFAULT_TOC_LIMIT)
    .option("--no-headless", "do not run the browser in headless mode")
    .option("-i, --insecure", "ignore SSL/TLS errors")
    .option("-y, --hyphenation", "allow automatic hyphenation if the page/browser decides for it (by default hyphenation will be disabled)")
    .option("-l, --links", "include the \"Related documents\" and \"More in this topic\" sections in the generated content pages")
    .option("-r, --retries <number>", "maximum number of retries to load a page", intParser, DEFAULT_RETRIES)
    .option("-e, --page-http-error <statuscode>", "an HTTP statuscode that if received from a page URL, triggers a retry for the given page (can be specified multiple times)", collect, [])
    .option("--resource-http-error <statuscode>", "an HTTP statuscode that if received from a domain in the \"--domain\" list while loading a resource for a page, triggers a retry for the given page (can be specified multiple times)", collect, [])
    .option("--resource-http-error-domain-suffix <suffix>", "a domain suffix to watch resource HTTP errors for (can be specified multipe times, extends the default list)", collect, DEFAULT_RESOURCE_HTTP_ERROR_DOMAIN_SUFFIXES)
    .option("--resource-http-error-url-exception", "a regular expression for the URL of a resource of the page and if matched, HTTP errors are ignored (can be specified multipe times, extends the default list)", collectRegExps, DEFAULT_RESOURCE_HTTP_ERROR_URL_EXCEPTIONS)
    .option("-d, --user-dir <path>", "path to a directory where the Chromium user profile (with cookies, cache) will be stored and kept even when the execution stops. If not specified, a random temporary directory is created for the duration of the run and is deleted, when execution stops.")
    .option("-f, --pdf-dir <path>", "path to a directory where the intermediary PDFs are stored and kept (even when the execution stops) and looked for. This option allows to continue an interrupted PDF generation process. If not specified, a random temporary directory is created for the duration of the run and is deleted, when execution stops.")
    .option("--no-pdf-cleanup", "disables removal of empty pages (on Linux)")
    .option("--pdf-cleanup-threshold", "adjusts the \"empty page detector\" threshold (based on inkcov output of Ghostscript)", parseFloat, DEFAULT_PDF_CLEANUP_THRESHOLD)
    .option("--ghostscript-path", "path to the Ghostscript executable (used for detection of empty pages)", DEFAULT_GHOSTSCRIPT_PATH)
    .option("--pdf-omit-background", "set \"omitBackground\" to true during PDF generation")
    .option("--no-pdf-print-background", "set \"printBackground\" to false during PDF generation")
    .option("--pdf-top-bottom-margin", "set the top and bottom margins for PDF generation", intParser, DEFAULT_PDF_TOP_BOTTOM_MARGIN)
    .option("--pdf-left-right-margin", "set the left and right margins for PDF generation", intParser, DEFAULT_PDF_LEFT_RIGHT_MARGIN)
    .option("--pdf-display-header-footer", "display the page header and footer during PDF generation")
    .option("--force", "render pages and save them as PDF even if a PDF for the given URL already exists in the \"--pdf-dir\" directory")
    .option("-w, --wait-time <seconds>", "number of seconds to wait if we've tried all proxies and all resulted in HTTP errors and/or throttling", DEFAULT_WAIT_TIME)
    .option("--pdf-timeout <milliseconds>", "PDF generation timeout", DEFAULT_PDF_TIMEOUT)
    .option("--title-caption <string>", "a string to be put below the document title on the table-of-contents page", defaultTitleCaption)
    .option("-c, --leniency", "increase the leniency towards the server (i.e. save the page as PDF even despite some errors from the server), you can specify this option multiple times. This can speed up the overall PDF generation process, but might result in a couple of missing images.", (d, p) => { return p + 1 }, DEFAULT_LENIENCY)
    .option("-b, --new-browser-per-urls <number>", "start a new browser after having processed this many URLs, regardless of whether there were any HTTP errors", DEFAULT_NEW_BROWSER_PER_URLS)
    .addOption(new Option("--log-level <level>", "set the log level").choices(Object.keys(logger.levels)).default(DEFAULT_LOG_LEVEL))
    .addOption(new Option("--pdf-page-size <size>", "the page format/size for the PDF (as per puppeteer's API)").choices(PAGE_SIZES).default(DEFAULT_PAGE_SIZE))
    .addOption(new Option("--idle-concurrency <number>", "maximum number concurrent of network connections to be considered inactive").argParser(intParser).default(DEFAULT_IDLE_CONCURRENCY).hideHelp())
    .action(async(url, options, command) => {
      if (options.pageHttpError.length == 0) {
        options.pageHttpError = DEFAULT_PAGE_HTTP_RETRY_STATUS_CODES;
      }
      if (options.resourceHttpError.length == 0) {
        options.resourceHttpError = DEFAULT_RESOURCE_HTTP_RETRY_STATUS_CODES;
      }
      options.defaultUserAgent = DEFAULT_USER_AGENT;
      await main(proc, url, options, command);
    });
  await program.parseAsync(proc.argv);
}

if (esMain(import.meta)) {
  cli(process);
}
